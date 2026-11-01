import { useLayoutEffect, useRef, useState } from "react";
import { errorText } from "../../api/client.ts";
import type { ApiClient } from "../../api/client.ts";
import type { CompanyRequestPrefill, Session } from "../../api/types.ts";
import { Dialog } from "../../shared/Dialog.tsx";
import { LandingOverview } from "./LandingOverview.tsx";
import { ResultFeed } from "./ResultFeed.tsx";
import { TypingExample } from "./TypingExample.tsx";
import { SearchWarning } from "./SearchWarning.tsx";
import { useWorkspace } from "./useWorkspace.ts";
interface Props {
  client: ApiClient;
  session: Session | null;
  active: boolean;
  reducedMotion: boolean;
  onSignIn: (reason?: string) => void;
  dialogOpen: boolean;
  onCompanyRequest: (prefill: CompanyRequestPrefill) => void;
  onAccount: () => void;
}
export function SearchWorkspace({
  client,
  session,
  active,
  reducedMotion,
  onSignIn,
  dialogOpen,
  onCompanyRequest,
  onAccount,
}: Props) {
  const workspace = useWorkspace(client, session, () =>
    onSignIn(
      "Sign in to interpret and save your search. Your unsent text stays here.",
    ),
  );
  const { state, search, query } = workspace;
  const [focused, setFocused] = useState(false),
    [pendingDelete, setPendingDelete] = useState<string | null>(null),
    [deleteError, setDeleteError] = useState(""),
    [deleting, setDeleting] = useState(false);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const inputRef = useRef<HTMLTextAreaElement>(null),
    focusAfterDelete = useRef(false);
  useLayoutEffect(() => {
    if (!active) setPendingDelete(null);
    if (active && pendingDelete === null && focusAfterDelete.current) {
      focusAfterDelete.current = false;
      inputRef.current?.focus();
    }
  }, [active, pendingDelete]);
  const deleteSearch = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await workspace.remove(pendingDelete);
      focusAfterDelete.current = true;
      setPendingDelete(null);
      setDeleteError("");
    } catch (error) {
      setDeleteError(errorText(error));
    } finally {
      setDeleting(false);
    }
  };
  return (
    <section
      id="jobs-page"
      className={`page${state.searches.length ? "" : " is-first-search"}`}
      hidden={!active}
    >
      <div className="search-workspace">
        <div className="search-sidebar">
          <span className="eyebrow">YOUR SEARCHES</span>
          <div id="search-tabs" role="tablist" aria-label="Saved searches">
            {state.searches.map((item, index) => (
              <div className="search-tab" key={item.id}>
                <button
                  ref={(node) => {
                    if (node) tabRefs.current.set(item.id, node);
                    else tabRefs.current.delete(item.id);
                  }}
                  role="tab"
                  tabIndex={
                    state.selectedId === item.id ||
                    (state.selectedId === null && index === 0)
                      ? 0
                      : -1
                  }
                  aria-selected={state.selectedId === item.id}
                  aria-controls="jobs-page"
                  onKeyDown={(event) => {
                    const offset =
                      event.key === "ArrowRight"
                        ? 1
                        : event.key === "ArrowLeft"
                          ? -1
                          : 0;
                    const target =
                      event.key === "Home"
                        ? state.searches[0]
                        : event.key === "End"
                          ? state.searches.at(-1)
                          : offset
                            ? state.searches[
                                (index + offset + state.searches.length) %
                                  state.searches.length
                              ]
                            : undefined;
                    if (target) {
                      event.preventDefault();
                      workspace.select(target.id);
                      tabRefs.current.get(target.id)?.focus();
                    }
                  }}
                  onClick={() => workspace.select(item.id)}
                >
                  {item.title || "Saved search"}
                </button>
                <button
                  className="tab-remove"
                  aria-label={`Delete ${item.title || "search"}`}
                  onClick={() => {
                    setDeleteError("");
                    setPendingDelete(item.id);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <button
            className="add-search"
            id="add-search"
            onClick={() => {
              workspace.newSearch();
              inputRef.current?.focus();
            }}
          >
            + New search
          </button>
        </div>
        <div className="search-main">
          {search ? null : (
            <div className="search-intro" id="search-intro">
              <span className="eyebrow">YOUR FIRST SEARCH</span>
              <h1 id="search-intro-title">
                Fresh jobs.
                <br />
                <span>No paid placement.</span>
              </h1>
              <p>
                Fresh listings from company career pages. See exactly which
                companies are included.
              </p>
            </div>
          )}
          <div className="search-compose">
            <form
              id="job-search"
              onSubmit={(event) => {
                event.preventDefault();
                void workspace.submit();
              }}
            >
              <label htmlFor="query" id="query-label">
                {search ? "Your search" : "What work are you looking for?"}
              </label>
              <div className="query-field">
                <div className="query-editor">
                  <textarea
                    ref={inputRef}
                    id="query"
                    rows={2}
                    spellCheck={false}
                    aria-describedby="search-guidance"
                    value={query}
                    onChange={(event) => workspace.setQuery(event.target.value)}
                    onFocus={() => {
                      workspace.beginEditing();
                      setFocused(true);
                    }}
                    onBlur={() => setFocused(false)}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        void workspace.submit();
                      }
                    }}
                  />
                  <TypingExample
                    enabled={active && !focused && !query.trim() && !dialogOpen}
                    reducedMotion={reducedMotion}
                  />
                </div>
                <button
                  type="submit"
                  className="search-submit"
                  disabled={
                    !session ||
                    state.busy ||
                    (!!session.user && !session.capabilities.search)
                  }
                >
                  Search <span>↵</span>
                </button>
              </div>
            </form>
            <p className="search-guidance" id="search-guidance">
              Be as specific as you need. We’ll show how your requirements are
              handled.
            </p>
          </div>
          <div id="search-status" className="helper" role="status">
            {state.status ||
              (session?.user && !session.capabilities.search
                ? "Search interpretation is unavailable right now. Your accepted searches remain available."
                : "")}
            {state.proposal ? (
              <>
                <strong>This search needs your decision.</strong>
                <p>
                  {state.proposal.message ||
                    "Some requirements cannot be applied."}
                </p>
                {state.proposal.requirements
                  .filter((item) => item.handling === "unsatisfied")
                  .map((item, index) => (
                    <p key={item.id ?? index}>
                      {item.text}: {item.reason || "not supported"}
                    </p>
                  ))}
                {state.proposal.warnings.map((warning, index) => (
                  <SearchWarning
                    key={index}
                    warning={warning}
                    onCompanyRequest={onCompanyRequest}
                  />
                ))}
                <button
                  className="button outline"
                  id="confirm-search-proposal"
                  disabled={state.busy}
                  onClick={() => void workspace.confirm()}
                >
                  Accept these limitations
                </button>
              </>
            ) : null}
          </div>
          <div id="search-accounting">
            {search?.requirements
              .filter((item) =>
                ["unsatisfied", "unsupported", "unmet"].includes(item.handling),
              )
              .map((item, index) => (
                <p key={item.id ?? index}>
                  <strong>Not met:</strong> {item.text}
                  {item.reason ? ` · ${item.reason}` : ""}
                </p>
              ))}
            {search?.warnings.map((warning, index) => (
              <SearchWarning
                key={index}
                warning={warning}
                onCompanyRequest={onCompanyRequest}
              />
            ))}
          </div>
        </div>
      </div>
      {state.searches.length ? null : <LandingOverview />}
      {search?.status === "ready" ? (
        <ResultFeed
          client={client}
          search={search}
          active={active}
          paused={state.busy}
          reducedMotion={reducedMotion}
          session={session}
          onSignIn={onSignIn}
          onAccount={onAccount}
        />
      ) : null}
      <Dialog
        id="delete-search-dialog"
        open={pendingDelete !== null && active}
        onClose={() => {
          if (!deleting) setPendingDelete(null);
        }}
        labelledBy="delete-search-title"
        describedBy="delete-search-description"
      >
        <div className="dialog-heading">
          <span className="eyebrow">YOUR SEARCHES</span>
          <button
            className="icon-close"
            aria-label="Cancel deleting search"
            onClick={() => setPendingDelete(null)}
          >
            ×
          </button>
        </div>
        <h2 id="delete-search-title">Delete this search?</h2>
        <p id="delete-search-description">
          {deleteError ||
            "This saved search will be deleted from your account."}
        </p>
        <div className="dialog-actions">
          <button
            className="button outline"
            autoFocus
            onClick={() => setPendingDelete(null)}
          >
            Keep search
          </button>
          <button
            className="button dark"
            id="confirm-delete-search"
            disabled={deleting}
            onClick={() => void deleteSearch()}
          >
            Delete search
          </button>
        </div>
      </Dialog>
    </section>
  );
}
