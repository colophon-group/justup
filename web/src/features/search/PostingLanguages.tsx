// Search-owned options use the real catalogue; interface language remains a separate setting.
import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.ts";
import { isAbortError } from "../../api/client.ts";
import type { SearchOptionsCatalogue, SearchScope } from "../../api/types.ts";
import { useInterfaceLocale } from "../../i18n/LocaleProvider.tsx";
import { Dialog } from "../../shared/Dialog.tsx";

interface Props {
  client: ApiClient;
  scope: SearchScope | null;
  selected: string[];
  revision: number | undefined;
  supported: boolean;
  disabled: boolean;
  saving: boolean;
  active: boolean;
  onSave: (languages: string[], revision?: number) => Promise<boolean>;
}
export function PostingLanguages({ client, scope, selected, revision, supported, disabled, saving, active, onSave }: Props) {
  const { t, locale } = useInterfaceLocale();
  const [catalogue, setCatalogue] = useState<SearchOptionsCatalogue | null>(null);
  const [attempt, setAttempt] = useState(0), [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false), [filter, setFilter] = useState("");
  const [draft, setDraft] = useState<string[]>([]), [baseRevision, setBaseRevision] = useState<number>();
  const [failed, setFailed] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => client.onSessionResumed(() => setAttempt(value => value + 1)), [client]);
  useEffect(() => {
    const controller = new AbortController();
    setCatalogue(null);
    if (!scope) return;
    setLoading(true);
    void client.getSearchOptions(controller.signal, scope).then(value => {
      if (!controller.signal.aborted) setCatalogue(value);
    }).catch(error => { if (!isAbortError(error) && !controller.signal.aborted) setCatalogue(null); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, scope, attempt, locale]);
  useEffect(() => { if (!active) setOpen(false); }, [active]);
  const close = () => { if (!saving) { setOpen(false); trigger.current?.focus(); } };
  const names = new Map(catalogue?.postingLanguages.map(item => [item.id, item.name]));
  // Previously saved identifiers may disappear from a later import. Keep them
  // available for removal, without offering arbitrary new values.
  const options = [...(catalogue?.postingLanguages ?? []), ...selected.filter(id => !names.has(id)).map(id => ({ id, name: id }))];
  const visible = options.filter(item => `${item.name} ${item.id}`.toLocaleLowerCase(locale).includes(filter.toLocaleLowerCase(locale)));
  return <div className="posting-languages">
    <button ref={trigger} type="button" id="posting-languages" className="language-trigger"
      disabled={disabled || loading || !catalogue || !supported} aria-haspopup="dialog" aria-expanded={open}
      aria-describedby={!catalogue || !supported ? "posting-languages-unavailable" : undefined}
      onClick={() => { setDraft([...selected]); setBaseRevision(revision); setFilter(""); setFailed(false); setOpen(true); }}>
      {t("Posting languages")}: {selected.length ? t("{count} selected", { count: selected.length }) : t("Any language")}
    </button>
    {!catalogue || !supported ? <span className="helper" id="posting-languages-unavailable" role="status">
      {loading ? t("Loading posting languages…") : t("Posting language options are unavailable.")}
      {!loading && scope ? <> <button type="button" className="text-link" onClick={() => setAttempt(value => value + 1)}>{t("Try again")}</button></> : null}
    </span> : null}
    <Dialog open={open && active} onClose={close} labelledBy="posting-language-title" describedBy="posting-language-help" id="posting-language-dialog">
      <div className="dialog-heading"><span className="eyebrow">{t("SEARCH OPTIONS")}</span><button type="button" className="icon-close" disabled={saving} onClick={close} aria-label={t("Close")}>×</button></div>
      <h2 id="posting-language-title">{t("Posting languages")}</h2>
      <p id="posting-language-help">{t("Choose any languages. No selection means any language. These options also apply alongside your search text.")}</p>
      {revision === undefined ? <p>{t("For a new search, language choices stay in this page until you submit Search. Reloading or signing in clears these unsaved choices.")}</p> : null}
      <label htmlFor="posting-language-filter">{t("Find a language")}</label>
      <input type="search" id="posting-language-filter" value={filter} onChange={event => setFilter(event.target.value)} />
      <fieldset className="language-options" disabled={saving || disabled || !catalogue || !supported}>
        <legend className="sr-only">{t("Posting languages")}</legend>
        {visible.map(item => <label key={item.id}>
          <input type="checkbox" value={item.id} checked={draft.includes(item.id)} onChange={event => setDraft(values => event.target.checked ? [...values, item.id] : values.filter(id => id !== item.id))} />
          <span lang="en">{item.name} <small>{item.id}</small></span>
        </label>)}
        {!visible.length ? <p>{t("No matching languages.")}</p> : null}
      </fieldset>
      <p role="status">{failed ? t("Posting language changes could not be confirmed. Review the saved choices before trying again.") : t("{count} selected", { count: draft.length })}</p>
      <div className="dialog-actions">
        {failed ? <button type="button" id="review-posting-languages" className="button outline" disabled={saving} onClick={() => {
          // An explicit review replaces staged choices with the last canonical
          // snapshot. A concurrent revision still needs a new CAS acknowledgement.
          setDraft([...selected]); setBaseRevision(revision); setFilter(""); setFailed(false);
        }}>{t("Review saved choices")}</button> : null}
        <button type="button" className="text-link" disabled={saving} onClick={() => setDraft([])}>{t("Any language")}</button>
        <button type="button" className="button outline" disabled={saving} onClick={close}>{t("Cancel")}</button>
        <button type="button" id="apply-posting-languages" className="button" disabled={failed || saving || disabled || !catalogue || !supported} onClick={async () => {
          const success = await onSave([...draft].sort(), baseRevision);
          if (success) { setOpen(false); trigger.current?.focus(); } else setFailed(true);
        }}>{t(saving ? "Saving…" : "Apply")}</button>
      </div>
    </Dialog>
  </div>;
}
