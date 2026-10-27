import { createTranslator } from 'next-intl';
import activeMessages from '../../../messages/en.json';

/**
 * Translator for code that runs outside React — API route handlers,
 * validators shared by client and server, starter templates, and so on.
 * Components should keep using `useTranslations` / `getTranslations`.
 *
 * The UI ships English only (messages/en.json, see src/i18n/request.ts).
 */

type Catalogue = Record<string, unknown>;

function loadCatalogue(): { locale: string; messages: Catalogue } {
  return { locale: 'en', messages: activeMessages as Catalogue };
}

let cached: { locale: string; messages: Catalogue } | null = null;

export type TranslateValues = Record<string, string | number | Date>;
export type Translate = (key: string, values?: TranslateValues) => string;

/**
 * Returns a `t(key, values)` bound to `namespace` (e.g. `'Api'`,
 * `'Validation.flows'`). Messages use ICU syntax like the rest of the
 * catalogue; literal WhatsApp `{{1}}` must be passed in as a value.
 */
export function getT(namespace: string): Translate {
  cached ??= loadCatalogue();
  const t = createTranslator({
    locale: cached.locale,
    messages: cached.messages,
    namespace: namespace as never,
  }) as unknown as (key: string, values?: TranslateValues) => string;
  return (key, values) => t(key, values);
}
