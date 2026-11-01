// One owner-scoped CAS writer saves drafts without letting delayed replies replace current typing.
import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { ApiError, errorText, isAbortError } from "../../api/client.ts";
import type { ApiClient } from "../../api/client.ts";
import type { SavedWorkspaceState, Search, SearchScope, WorkspaceSnapshot } from "../../api/types.ts";
import { mergeWorkspaceEdits, savedWorkspace } from "./workspace.ts";
import type { Action, Workspace } from "./workspace.ts";

interface Props {
  client: ApiClient;
  scope: SearchScope | null;
  owner: string | undefined;
  hasVisitor: boolean;
  onVisitorRebootstrap: () => Promise<void>;
  state: Workspace;
  current: MutableRefObject<Workspace>;
  serial: MutableRefObject<number>;
  apply: (action: Action) => void;
}
interface Conflict { remote: WorkspaceSnapshot; searches: Search[]; base: SavedWorkspaceState }
interface RecoveredCreate { local: SavedWorkspaceState; remote: SavedWorkspaceState }
function storedView(local: SavedWorkspaceState, recovered: RecoveredCreate | null): SavedWorkspaceState {
  if (!recovered) return local;
  const projected = mergeWorkspaceEdits(recovered.local, local, recovered.remote);
  if (local.activeSearchId === null && local.drafts.new !== recovered.local.drafts.new) projected.activeSearchId = null;
  return projected;
}
function deletedSearchDrafts(conflict: Conflict, local: Workspace) {
  const known = new Set(conflict.searches.map(search => search.id));
  const drafts = new Map(Object.entries(local.drafts).filter(([id]) => id !== "new" && !known.has(id)));
  if (local.selectedId && !known.has(local.selectedId) && !drafts.has(local.selectedId))
    drafts.set(local.selectedId, local.searches.find(search => search.id === local.selectedId)?.query ?? "");
  return [...drafts].map(([id, text]) => ({ id, text, title: local.searches.find(search => search.id === id)?.title || null }));
}
const fingerprint = (state: SavedWorkspaceState) => JSON.stringify({
  activeSearchId: state.activeSearchId,
  drafts: Object.fromEntries(Object.entries(state.drafts).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
});
export function useWorkspacePersistence({ client, scope, owner, hasVisitor, onVisitorRebootstrap, state, current, serial, apply }: Props) {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [syncError, setSyncError] = useState("");
  const [viewError, setViewError] = useState("");
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [loading, setLoading] = useState(false), [recovering, setRecovering] = useState(false);
  const [viewed, setViewed] = useState<ReadonlySet<string>>(() => new Set());
  const guard = useRef({ generation: 0, controller: new AbortController() });
  const stored = useRef<WorkspaceSnapshot | null>(null), base = useRef<SavedWorkspaceState>({ activeSearchId: null, drafts: {} });
  const heldConflict = useRef<Conflict | null>(null), ready = useRef(false);
  const reading = useRef<Promise<void> | null>(null), saving = useRef<Promise<void> | null>(null);
  const pendingViewed = useRef(new Map<string, Promise<void> | null>());
  const lastSaveAt = useRef(0);
  const reclaimed = useRef(false);
  const recoveredCreate = useRef<RecoveredCreate | null>(null);
  const pendingDeletion = useRef<SavedWorkspaceState | null>(null), refreshingDeletion = useRef<Promise<void> | null>(null);
  const project = useCallback(() => {
    const local = savedWorkspace(current.current,
      scope === "visitor" && (!hasVisitor || reclaimed.current) && stored.current?.revision === 0 && current.current.searches.length === 0
        && stored.current.viewed.length === 0 && stored.current.recoveredDrafts.length === 0);
    // A lost create keeps its field visible for same-key retry. Its unchanged
    // preflight text is already durable; only subsequent edits are new writes.
    return storedView(local, recoveredCreate.current);
  }, [current, scope, hasVisitor]);
  const valid = (generation: number) => guard.current.generation === generation && !guard.current.controller.signal.aborted;
  const noteSnapshot = useCallback((next: WorkspaceSnapshot) => {
    stored.current = next; setSnapshot(next);
    setViewed(previous => new Set([...previous, ...next.viewed.map(item => item.jobId)]));
  }, []);
  const read = useCallback(async (creation?: { id: string; submitted: string }, preserveCurrent = false, rebaseStored?: SavedWorkspaceState) => {
    if (!scope) return;
    const generation = guard.current.generation, signal = guard.current.controller.signal;
    const started = serial.current;
    const initialStored = rebaseStored ?? base.current;
    setLoading(true); ready.current = false;
    try {
      const [searches, remote] = await Promise.all([client.listSearches(signal, scope), client.getWorkspace(scope, signal)]);
      if (!valid(generation)) return;
      const local = savedWorkspace(current.current);
      const projected = storedView(local, recoveredCreate.current);
      const edited = preserveCurrent || started !== serial.current || fingerprint(local) !== fingerprint(base.current);
      const clashes = rebaseStored
        ? [...new Set([...Object.keys(projected.drafts), ...Object.keys(remote.state.drafts), ...Object.keys(initialStored.drafts)])]
          .some(id => projected.drafts[id] !== initialStored.drafts[id] && remote.state.drafts[id] !== initialStored.drafts[id] && projected.drafts[id] !== remote.state.drafts[id])
          || projected.activeSearchId !== initialStored.activeSearchId && remote.state.activeSearchId !== initialStored.activeSearchId && projected.activeSearchId !== remote.state.activeSearchId
        : edited && (Object.entries(local.drafts).some(([id, text]) => remote.state.drafts[id] !== undefined && remote.state.drafts[id] !== text
        && !(creation?.id === id && remote.state.drafts[id] === creation.submitted))
        || !!creation && remote.state.activeSearchId !== null && remote.state.activeSearchId !== creation.id);
      // Merge actual saved-state deltas first, then retain only the transient
      // unresolved-request footprint that is still needed for same-key retry.
      const saved = rebaseStored && !clashes
        ? mergeWorkspaceEdits(projected, local, mergeWorkspaceEdits(initialStored, projected, remote.state)) : remote.state;
      noteSnapshot(remote); base.current = remote.state; ready.current = true;
      apply({ type: "restored", searches, saved, preserveLocal: rebaseStored ? clashes : edited, defaultSelection: remote.revision === 0 });
      const held = clashes ? { remote, searches, base: rebaseStored ? initialStored : remote.state } : null;
      heldConflict.current = held; setConflict(held); setSyncError("");
    } catch (error) {
      if (valid(generation) && !isAbortError(error)) setSyncError(`Saved workspace unavailable. ${errorText(error)}`);
    } finally { if (valid(generation)) setLoading(false); }
  }, [client, scope, owner, current, serial, apply, noteSnapshot]);
  useEffect(() => {
    const controller = new AbortController(), generation = guard.current.generation + 1;
    guard.current = { generation, controller };
    stored.current = null; ready.current = false; saving.current = null;
    lastSaveAt.current = 0; base.current = { activeSearchId: null, drafts: {} };
    reclaimed.current = false;
    recoveredCreate.current = null;
    pendingDeletion.current = null; refreshingDeletion.current = null;
    pendingViewed.current.clear(); heldConflict.current = null; setConflict(null); setSnapshot(null); setViewed(new Set()); setViewError("");
    if (scope) reading.current = read();
    return () => { controller.abort(); ready.current = false; };
  }, [scope, owner, read]);
  const refreshOwnedDeletion = useCallback(async (): Promise<void> => {
    const transition = pendingDeletion.current;
    if (!transition) return;
    if (refreshingDeletion.current) return refreshingDeletion.current;
    const generation = guard.current.generation;
    ready.current = false; setLoading(true);
    const work = async () => {
      // A successful owned DELETE can reclaim its visitor even when this
      // browser's list is stale. Renew before either private hydration read.
      if (scope === "visitor") await onVisitorRebootstrap();
      if (!valid(generation)) throw new DOMException("Workspace changed", "AbortError");
      await read(undefined, true, transition);
      if (!valid(generation)) throw new DOMException("Workspace changed", "AbortError");
      if (!ready.current) throw new Error("Reconnect the saved workspace before continuing.");
      if (recoveredCreate.current) recoveredCreate.current.remote = base.current;
      reclaimed.current = scope === "visitor" && stored.current?.revision === 0;
      pendingDeletion.current = null;
    };
    const running = work().catch(error => {
      if (valid(generation)) { ready.current = false; if (!isAbortError(error)) setSyncError(errorText(error)); }
      throw error;
    }).finally(() => { if (valid(generation)) { refreshingDeletion.current = null; setLoading(false); } });
    refreshingDeletion.current = running; reading.current = running;
    return running;
  }, [scope, onVisitorRebootstrap, read]);
  const sendViewed = useCallback(async (jobId: string) => {
    if (!scope) return;
    const running = pendingViewed.current.get(jobId);
    if (running) return running;
    const generation = guard.current.generation, signal = guard.current.controller.signal;
    const request = client.markViewed(jobId, scope, signal).then(() => {
      if (valid(generation)) { pendingViewed.current.delete(jobId); if (!pendingViewed.current.size) setViewError(""); }
    }).catch(error => {
      if (valid(generation)) {
        if (error instanceof ApiError && error.status === 404) {
          pendingViewed.current.delete(jobId);
          setViewError("This position is no longer available to sync.");
          return;
        }
        else pendingViewed.current.set(jobId, null);
      }
      throw error;
    });
    pendingViewed.current.set(jobId, request);
    return request;
  }, [client, scope, owner]);
  const save = useCallback(async (): Promise<void> => {
    if (!scope) return;
    if (saving.current) return saving.current;
    const generation = guard.current.generation, signal = guard.current.controller.signal;
    const work = async () => {
      await reading.current;
      if (!valid(generation)) throw new DOMException("Workspace changed", "AbortError");
      if (pendingDeletion.current || !ready.current || !stored.current) throw new Error("Reconnect the saved workspace before continuing.");
      if (heldConflict.current) throw new Error("Review the draft conflict before continuing. Your unsaved text is still here.");
      if (valid(generation)) {
        const next = project();
        if (fingerprint(next) === fingerprint(base.current)) return;
        const clearing = scope === "visitor" && stored.current.revision > 0 && next.activeSearchId === null
          && current.current.searches.length === 0 && stored.current.viewed.length === 0 && stored.current.recoveredDrafts.length === 0
          && Object.values(next.drafts).every(text => text.length === 0);
        try {
          lastSaveAt.current = Date.now();
          const updated = await client.saveWorkspace(scope, next, stored.current.revision, signal, clearing);
          if (!valid(generation)) throw new DOMException("Workspace changed", "AbortError");
          noteSnapshot(updated); base.current = updated.state; setSyncError("");
          reclaimed.current = clearing && updated.revision === 0;
          if (reclaimed.current) {
            recoveredCreate.current = null;
            // Canonical revision zero is the response bound to our successful
            // clear. Renew its stale hint without remounting newer typed text.
            await onVisitorRebootstrap();
            if (!valid(generation)) throw new DOMException("Workspace changed", "AbortError");
            reading.current = read(); await reading.current;
          }
        } catch (error) {
          if (clearing && valid(generation) && error instanceof ApiError && (error.status === 0 || error.status === 401 || error.status >= 500 || error.code === "invalid_response")) {
            // A committed clear may lose its entire reply. Obtain a current
            // hint, then inspect real storage before another private write.
            await onVisitorRebootstrap();
            if (!valid(generation)) throw new DOMException("Workspace changed", "AbortError");
            reading.current = read(); await reading.current;
            if (ready.current && stored.current && (stored.current.revision === 0 || fingerprint(stored.current.state) === fingerprint(next))) {
              reclaimed.current = stored.current.revision === 0;
              if (reclaimed.current) recoveredCreate.current = null;
              return;
            }
          }
          if (valid(generation) && error instanceof ApiError && (
            error.status === 409 && error.code === "revision_conflict"
            || error.status === 404 && error.code === "not_found"
            || error.status === 400 && error.code === "invalid_input"
          )) {
            const [remote, searches] = await Promise.all([client.getWorkspace(scope, signal), client.listSearches(signal, scope)]);
            if (!valid(generation)) throw new DOMException("Workspace changed", "AbortError");
            const held = { remote, searches, base: base.current };
            const known = new Set(searches.map(search => search.id));
            if (error.status === 409 && fingerprint(remote.state) === fingerprint(next)
              && (next.activeSearchId === null || known.has(next.activeSearchId))
              && Object.keys(next.drafts).every(id => id === "new" || known.has(id))
              && !deletedSearchDrafts(held, current.current).length) {
              // A save can commit before its reply is lost. A retry then has an
              // old revision even though its complete payload is already stored.
              // Advance only the saved base; newer typing still needs its flush.
              noteSnapshot(remote); base.current = remote.state; setSyncError("");
              return;
            }
            // A removed search can fail ownership validation before the server
            // reaches its revision check. Only turn that error into a conflict
            // when the authoritative list actually confirms a missing search.
            if (error.status !== 409 && !deletedSearchDrafts(held, current.current).length) throw error;
            noteSnapshot(remote); heldConflict.current = held; setConflict(held);
            throw new Error("This workspace changed in another tab. Review both copies before saving.");
          }
          throw error;
        }
      }
    };
    const running = work().catch(error => {
      if (valid(generation) && !isAbortError(error)) setSyncError(errorText(error));
      throw error;
    }).finally(() => { if (valid(generation)) saving.current = null; });
    saving.current = running;
    return running;
  }, [client, scope, owner, current, noteSnapshot, project, onVisitorRebootstrap, read]);
  useEffect(() => {
    if (!scope || !ready.current || heldConflict.current) return;
    // Autosave uses at most twelve writes per minute; deliberate submission and
    // sign-in can flush immediately without waiting for this background cadence.
    const timer = setTimeout(() => { void save().catch(() => {}); }, Math.max(800, 5000 - (Date.now() - lastSaveAt.current)));
    return () => clearTimeout(timer);
  }, [scope, state.drafts, state.selectedId, state.searches, snapshot?.revision, save]);
  const flush = useCallback(async (signal?: AbortSignal) => {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    if (pendingDeletion.current) await refreshOwnedDeletion();
    await save();
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    // An older autosave may have been in flight when the caller requested the
    // flush. Save the latest edits once more, rather than sending credentials
    // with a draft still waiting behind that request.
    if (ready.current && fingerprint(project()) !== fingerprint(base.current)) await save();
    for (const jobId of pendingViewed.current.keys()) await sendViewed(jobId);
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    if (ready.current && fingerprint(project()) !== fingerprint(base.current)) throw new Error("Your latest edits are still being saved. Please try again.");
  }, [save, sendViewed, project, refreshOwnedDeletion]);
  const deleteOwnedSearch = async (id: string, onDeleted: () => void) => {
    if (!scope) throw new Error("Reconnect before changing saved searches.");
    const generation = guard.current.generation;
    await flush();
    if (!valid(generation)) throw new DOMException("Workspace changed", "AbortError");
    let release: () => void = () => {};
    reading.current = new Promise<void>(resolve => { release = resolve; });
    ready.current = false; setLoading(true);
    try {
      await client.deleteSearch(id, guard.current.controller.signal, scope);
      if (!valid(generation)) throw new DOMException("Workspace changed", "AbortError");
      onDeleted();
      const prune = (saved: SavedWorkspaceState): SavedWorkspaceState => ({
        activeSearchId: saved.activeSearchId === id ? null : saved.activeSearchId,
        drafts: Object.fromEntries(Object.entries(saved.drafts).filter(([key]) => key !== id)),
      });
      base.current = prune(base.current);
      if (recoveredCreate.current) recoveredCreate.current = { local: prune(recoveredCreate.current.local), remote: prune(recoveredCreate.current.remote) };
      pendingDeletion.current = base.current;
      // The deletion itself succeeded. A failed refresh stays visible and
      // blocks writes; Retry saving must resume this renewal, not a stale read.
      await refreshOwnedDeletion().catch(() => {});
    } catch (error) {
      if (valid(generation) && !isAbortError(error)) setSyncError(errorText(error));
      throw error;
    } finally { release(); if (valid(generation)) setLoading(false); }
  };
  useEffect(() => {
    const leave = () => { void flush().catch(() => {}); };
    window.addEventListener("pagehide", leave);
    return () => window.removeEventListener("pagehide", leave);
  }, [flush]);
  const resolveConflict = (choice: "local" | "saved") => {
    const held = heldConflict.current;
    if (!held) return;
    if (choice === "local" && deletedSearchDrafts(held, current.current).length) return;
    const known = new Set(held.searches.map(search => search.id));
    const remote = {
      activeSearchId: held.remote.state.activeSearchId && known.has(held.remote.state.activeSearchId) ? held.remote.state.activeSearchId : null,
      drafts: Object.fromEntries(Object.entries(held.remote.state.drafts).filter(([id]) => id === "new" || known.has(id))),
    };
    const saved = choice === "saved" ? remote : mergeWorkspaceEdits(held.base, savedWorkspace(current.current), remote);
    recoveredCreate.current = null;
    heldConflict.current = null; setConflict(null); base.current = held.remote.state;
    apply({ type: "restored", searches: held.searches, saved, preserveLocal: false, authoritative: true });
    setSyncError("");
    if (choice === "local") queueMicrotask(() => { void save().catch(() => {}); });
  };
  const recover = async (draftId: string, action: "use" | "discard") => {
    if (!scope || recovering) return;
    const generation = guard.current.generation;
    setRecovering(true);
    try {
      await flush();
      if (!stored.current || !valid(generation)) return;
      const next = await client.recoverDraft(scope, draftId, action, stored.current.revision, guard.current.controller.signal);
      if (!valid(generation)) return;
      noteSnapshot(next); base.current = next.state;
      recoveredCreate.current = null;
      apply({ type: "restored", searches: current.current.searches, saved: next.state, preserveLocal: false });
      setSyncError("");
      return true;
    } catch (error) {
      if (valid(generation) && !isAbortError(error)) {
        setSyncError(errorText(error));
        if (error instanceof ApiError && error.status === 409 && error.code === "revision_conflict") reading.current = read();
      }
      return false;
    } finally { if (valid(generation)) setRecovering(false); }
  };
  const markViewed = (jobId: string) => {
    if (viewed.has(jobId) && !pendingViewed.current.has(jobId)) return;
    const generation = guard.current.generation;
    setViewed(previous => new Set([...previous, jobId]));
    if (pendingViewed.current.get(jobId)) return;
    pendingViewed.current.set(jobId, null);
    void sendViewed(jobId).catch(error => {
      if (valid(generation) && !isAbortError(error)) setViewError(`Viewed status is not synced yet. ${errorText(error)}`);
    });
  };
  const refreshAfterCreate = async (creation?: { id: string; submitted: string }, unresolvedSubmitted?: string) => {
    const generation = guard.current.generation;
    const local = savedWorkspace(current.current);
    await saving.current?.catch(() => {});
    if (!valid(generation)) return;
    if (creation) recoveredCreate.current = null;
    reading.current = read(creation, !creation);
    await reading.current;
    if (!creation && unresolvedSubmitted !== undefined && valid(generation) && ready.current) {
      // Bind this baseline to the raw text flushed for this exact request. Do
      // not identify its search by matching query text or discard newer typing.
      recoveredCreate.current = { local: { ...local, drafts: { ...local.drafts, new: unresolvedSubmitted } }, remote: base.current };
    }
  };
  return { flush, deleteOwnedSearch, refreshAfterCreate, syncError: syncError || viewError, conflict, deletedSearchDrafts: conflict ? deletedSearchDrafts(conflict, state) : [], resolveConflict, recoveredDrafts: snapshot?.recoveredDrafts ?? [], recover, recovering, loading, viewed, markViewed,
    retry: () => { if (pendingDeletion.current) void flush().catch(() => {}); else if (!ready.current) reading.current = read(); else void flush().catch(() => {}); } };
}
