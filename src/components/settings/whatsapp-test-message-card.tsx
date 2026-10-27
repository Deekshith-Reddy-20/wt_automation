'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Loader2, Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type RecipientInfo = { configured: boolean; recipient: string | null };

/**
 * "Send test message" — the only path in the settings page that sends a
 * real WhatsApp message. The recipient is fixed server-side
 * (WHATSAPP_TEST_RECIPIENT); the user must confirm in a dialog first.
 */
export function WhatsAppTestMessageCard() {
  const t = useTranslations('Settings.whatsapp.testMessage');
  const [info, setInfo] = useState<RecipientInfo | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/whatsapp/config/test-message')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled) setInfo(data ?? { configured: false, recipient: null });
      })
      .catch(() => {
        if (!cancelled) setInfo({ configured: false, recipient: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function send() {
    setSending(true);
    setResult(null);
    try {
      const res = await fetch('/api/whatsapp/config/test-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      const data = await res.json();
      if (res.ok && data.accepted) {
        setResult({ ok: true, text: t('accepted', { id: data.message_id ?? '—' }) });
        toast.success(t('acceptedToast'));
      } else {
        setResult({ ok: false, text: data.error ?? t('failed') });
        toast.error(data.error ?? t('failed'), { duration: 10000 });
      }
    } catch {
      setResult({ ok: false, text: t('failed') });
    } finally {
      setSending(false);
      setConfirming(false);
    }
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="text-foreground text-base">{t('title')}</CardTitle>
        <CardDescription className="text-muted-foreground">{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {info === null ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : info.configured ? (
          <p className="text-muted-foreground">
            {t('recipient')} <code className="text-foreground">{info.recipient}</code>
          </p>
        ) : (
          <p className="text-amber-300">{t('notConfigured')}</p>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={!info?.configured || sending}
          onClick={() => setConfirming(true)}
        >
          {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          {t('button')}
        </Button>
        {result && (
          <p className={result.ok ? 'text-emerald-400 text-xs' : 'text-red-300 text-xs'}>{result.text}</p>
        )}
      </CardContent>

      <Dialog open={confirming} onOpenChange={(open) => !sending && setConfirming(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-amber-400" />
              {t('confirmTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('confirmBody', { recipient: info?.recipient ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={sending}>
              {t('cancel')}
            </Button>
            <Button onClick={send} disabled={sending}>
              {sending && <Loader2 className="size-4 animate-spin" />}
              {t('confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
