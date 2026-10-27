'use client';

// ============================================================
// InviteMemberDialog
//
// Two-step modal:
//   1. Form  — role + expiry + optional label → POST creates the invite.
//   2. Result — the share URL, returned ONCE. Copy-to-clipboard, plus a
//              "Send via WhatsApp" deep link that pre-fills wa.me with
//              a friendly message containing the URL.
//
// The plaintext token is server-stored only as a SHA-256 hash, so once
// the result step is dismissed the link is gone forever — the dialog
// shouts this in copy.
// ============================================================

import { useId, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Check, Copy, Loader2, MessageCircle, UserPlus } from 'lucide-react';

import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';

type InviteRole = 'admin' | 'agent' | 'viewer';

interface InviteMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful create so the parent re-fetches the
   *  pending-invitations list. */
  onCreated: () => void;
}

export const NEVER_EXPIRES = 'never';

export const EXPIRY_OPTIONS = [
  { value: '1', labelKey: 'days1' },
  { value: '7', labelKey: 'days7' },
  { value: '30', labelKey: 'days30' },
  { value: NEVER_EXPIRES, labelKey: 'never' },
] as const;

type ExpiryValue = (typeof EXPIRY_OPTIONS)[number]['value'];

const DEFAULT_EXPIRY: ExpiryValue = '7';

/** Request body for POST /api/account/invitations for a given expiry choice. */
export function inviteExpiryPayload(expiry: ExpiryValue): { expiresInDays: number } | { neverExpires: true } {
  return expiry === NEVER_EXPIRES ? { neverExpires: true } : { expiresInDays: Number(expiry) };
}

// Server caps label at 80 chars (see src/app/api/account/invitations/route.ts).
// Mirror it on the client so we short-circuit before the round-trip
// rather than letting the user submit and bounce off a 400.
const MAX_LABEL_LEN = 80;

interface CreatedInvite {
  url: string;
  role: InviteRole;
  /** `null` = the link never expires. */
  expiresInDays: number | null;
  /** Snapshotted at creation time so a later account rename can't
   *  retroactively change the wa.me message text on the result step. */
  accountName: string;
}

export function InviteMemberDialog({
  open,
  onOpenChange,
  onCreated,
}: InviteMemberDialogProps) {
  const t = useTranslations('Settings.invite');
  const tRoles = useTranslations('Settings.roles');
  const { account } = useAuth();
  const fieldId = useId();
  const [role, setRole] = useState<InviteRole>('agent');
  const [expiry, setExpiry] = useState<ExpiryValue>(DEFAULT_EXPIRY);
  const [label, setLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [result, setResult] = useState<CreatedInvite | null>(null);

  function reset() {
    setRole('agent');
    setExpiry(DEFAULT_EXPIRY);
    setLabel('');
    setResult(null);
    setCopied(false);
    setSubmitting(false);
  }

  async function handleCreate() {
    // Mirror the server's max-length check so we don't ship an
    // obviously-too-long label across the wire just to bounce off
    // a 400. The Input also has a `maxLength={MAX_LABEL_LEN}` cap
    // but a paste can land an over-limit string into state before
    // the limit kicks in on the next keystroke — this is the safety
    // net for that path.
    const trimmedLabel = label.trim();
    if (trimmedLabel.length > MAX_LABEL_LEN) {
      toast.error(t('labelTooLong', { max: MAX_LABEL_LEN }));
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/account/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role,
          ...inviteExpiryPayload(expiry),
          label: trimmedLabel || undefined,
        }),
      });

      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('createFailed'));
        return;
      }

      const data = (await res.json()) as {
        url: string;
        expiresInDays: number | null;
        neverExpires?: boolean;
      };

      setResult({
        url: data.url,
        role,
        expiresInDays: data.neverExpires ? null : data.expiresInDays,
        // Snapshot the account name into the result so the wa.me
        // share message has team context. Falls back to a generic
        // string if `account` hasn't loaded yet (shouldn't happen
        // — the dialog requires admin+ which requires a loaded
        // profile — but stay safe).
        accountName: account?.name ?? t('fallbackAccountName'),
      });
      onCreated();
    } catch (err) {
      console.error('[InviteMemberDialog] create error:', err);
      toast.error(t('networkError'));
    } finally {
      setSubmitting(false);
    }
  }

  async function copyToClipboard() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.url);
      setCopied(true);
      toast.success(t('copied'), { id: 'invite-link-copied' });
    } catch {
      // Most likely "not in a secure context" — happens on http://
      // local IPs. Surface the link in the toast so the admin can
      // hand-copy it.
      toast.error(t('clipboardBlocked'));
    }
  }

  function whatsappShareUrl(url: string): string {
    // Include the account name so the recipient knows which team
    // they're being invited to before clicking through. This matters
    // for users in multi-team contexts where "our wacrm account"
    // wouldn't be enough to disambiguate.
    const accountName = result?.accountName ?? t('fallbackAccountName');
    const message =
      result?.expiresInDays == null
        ? t('whatsappMessageNever', { accountName, url })
        : t('whatsappMessage', { accountName, expiresInDays: result.expiresInDays, url });
    return `https://wa.me/?text=${encodeURIComponent(message)}`;
  }

  const bold = (chunks: React.ReactNode) => <strong className="font-semibold text-foreground">{chunks}</strong>;
  const footerClass = 'sm:-mx-6 sm:-mb-6 sm:px-6';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Reset state when the dialog closes — both for cancel and
        // for dismissal after a successful create. The plaintext URL
        // is intentionally NOT preserved across opens.
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="gap-5 sm:max-w-lg sm:p-6">
        {result ? (
          <>
            <DialogHeader className="flex-row items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-success/12 text-success">
                <Check className="size-5" />
              </span>
              <div className="flex flex-col gap-1.5">
                <DialogTitle className="text-lg">{t('inviteCreated')}</DialogTitle>
                <DialogDescription>
                  {result.expiresInDays === null
                    ? t.rich('inviteCreatedDescNever', { role: tRoles(result.role), bold })
                    : t.rich('inviteCreatedDesc', {
                        role: tRoles(result.role),
                        days: result.expiresInDays,
                        bold,
                      })}
                </DialogDescription>
              </div>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor={`${fieldId}-url`}>{t('inviteLink')}</Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id={`${fieldId}-url`}
                    readOnly
                    value={result.url}
                    className="bg-muted font-mono text-xs"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <Button type="button" onClick={copyToClipboard} className="shrink-0">
                    {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                    {t('copy')}
                  </Button>
                </div>
              </div>

              <div
                role="note"
                className="flex gap-2.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs leading-relaxed text-foreground"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                <p>
                  <strong className="font-semibold">{t('saveLinkNow')}</strong>{' '}
                  <span className="text-muted-foreground">{t('saveLinkHint')}</span>
                </p>
              </div>

              {/* Anchor styled with `buttonVariants` rather than wrapping
                  in <Button asChild>. The wacrm Button is the Base UI
                  ButtonPrimitive — it has no Radix-style asChild slot.
                  Direct anchor preserves right-click "Open in new tab"
                  behaviour too. */}
              <a
                href={whatsappShareUrl(result.url)}
                target="_blank"
                rel="noreferrer noopener"
                className={buttonVariants({ variant: 'outline', className: 'w-full' })}
              >
                <MessageCircle className="size-4" />
                {t('sendViaWhatsApp')}
              </a>
            </div>

            <DialogFooter className={footerClass}>
              <Button onClick={() => onOpenChange(false)}>{t('done')}</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader className="flex-row items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary">
                <UserPlus className="size-5" />
              </span>
              <div className="flex flex-col gap-1.5">
                <DialogTitle className="text-lg">{t('dialogTitle')}</DialogTitle>
                <DialogDescription>{t('dialogDesc')}</DialogDescription>
              </div>
            </DialogHeader>

            <form
              id={`${fieldId}-form`}
              className="space-y-5"
              onSubmit={(e) => {
                e.preventDefault();
                if (!submitting) void handleCreate();
              }}
            >
              <div className="space-y-2">
                <Label htmlFor={`${fieldId}-role`}>{t('roleLabel')}</Label>
                <Select value={role} onValueChange={(v) => v && setRole(v as InviteRole)}>
                  <SelectTrigger id={`${fieldId}-role`} className="w-full" aria-describedby={`${fieldId}-role-hint`}>
                    <SelectValue>{tRoles(role)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectItem value="admin">{tRoles('admin')}</SelectItem>
                    <SelectItem value="agent">{tRoles('agent')}</SelectItem>
                    <SelectItem value="viewer">{tRoles('viewer')}</SelectItem>
                  </SelectContent>
                </Select>
                <p id={`${fieldId}-role-hint`} className="text-xs leading-relaxed text-muted-foreground">
                  {tRoles(`${role}Hint` as 'adminHint' | 'agentHint' | 'viewerHint')}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor={`${fieldId}-expiry`}>{t('validForLabel')}</Label>
                <Select value={expiry} onValueChange={(v) => v && setExpiry(v as ExpiryValue)}>
                  <SelectTrigger id={`${fieldId}-expiry`} className="w-full" aria-describedby={`${fieldId}-expiry-hint`}>
                    <SelectValue>{t(EXPIRY_OPTIONS.find((o) => o.value === expiry)!.labelKey)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    {EXPIRY_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {t(opt.labelKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p id={`${fieldId}-expiry-hint`} className="text-xs leading-relaxed text-muted-foreground">
                  {expiry === NEVER_EXPIRES ? t('neverHint') : t('validForHint')}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor={`${fieldId}-label`}>
                  {t('labelTitle')}
                  <span className="font-normal text-muted-foreground">{t('optional')}</span>
                </Label>
                <Input
                  id={`${fieldId}-label`}
                  placeholder={t('labelPlaceholder')}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  maxLength={MAX_LABEL_LEN}
                  aria-describedby={`${fieldId}-label-hint`}
                />
                <p id={`${fieldId}-label-hint`} className="text-xs leading-relaxed text-muted-foreground">
                  {t('labelHint')}
                </p>
              </div>
            </form>

            <DialogFooter className={footerClass}>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('cancel')}
              </Button>
              <Button
                type="submit"
                form={`${fieldId}-form`}
                disabled={submitting}
                className={cn(submitting && 'cursor-progress')}
              >
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('creating')}
                  </>
                ) : (
                  t('generateLink')
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
