// Pure workspace transitions keep accepted criteria separate from unsubmitted drafts.
import type { SavedWorkspaceState, Search, SearchProposal } from "../../api/types.ts";
export interface Workspace {
  searches: Search[];
  selectedId: string | null;
  drafts: Record<string, string>;
  status: string;
  proposal: SearchProposal | null;
  busy: boolean;
  deletedIds: ReadonlySet<string>;
}
export const emptyWorkspace = (): Workspace => ({
  searches: [],
  selectedId: null,
  drafts: {},
  status: "",
  proposal: null,
  busy: false,
  deletedIds: new Set(),
});
export const selectedSearch = (state: Workspace): Search | undefined =>
  state.searches.find((search) => search.id === state.selectedId);
export const draftKey = (id: string | null): string => id ?? "new";
export const queryText = (state: Workspace): string =>
  state.drafts[draftKey(state.selectedId)] ??
  selectedSearch(state)?.query ??
  "";
export function savedWorkspace(state: Workspace, omitEmptyNew = false): SavedWorkspaceState {
  const ids = new Set(state.searches.map(search => search.id));
  return {
    activeSearchId: state.selectedId && ids.has(state.selectedId) ? state.selectedId : null,
    drafts: Object.fromEntries(Object.entries(state.drafts).filter(([id, text]) => id === "new" ? !omitEmptyNew || text.length > 0 : ids.has(id)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
  };
}
// Only this browser's changes replace a newer stored copy after explicit review.
export function mergeWorkspaceEdits(base: SavedWorkspaceState, local: SavedWorkspaceState, remote: SavedWorkspaceState): SavedWorkspaceState {
  const drafts = { ...remote.drafts };
  for (const id of new Set([...Object.keys(base.drafts), ...Object.keys(local.drafts)])) {
    if (base.drafts[id] === local.drafts[id]) continue;
    if (local.drafts[id] === undefined) delete drafts[id];
    else drafts[id] = local.drafts[id];
  }
  return { activeSearchId: local.activeSearchId !== base.activeSearchId ? local.activeSearchId : remote.activeSearchId, drafts };
}
// A stream's invalid revision is reconciled canonically without dropping other
// in-flight searches. Real edits to a deleted search stay in explicit recovery.
export function reconcileInvalidatedSearch(state: Workspace, remote: Search[], invalidated: { id: string; revision: number } | null) {
  const local = invalidated && state.searches.find(search => search.id === invalidated.id && search.revision <= invalidated.revision);
  if (!local) return { searches: remote, authoritative: false, orphaned: false };
  const byId = new Map(remote.map(search => [search.id, search]));
  for (const search of state.searches) {
    if (search.id === local.id) continue;
    const saved = byId.get(search.id);
    if (!saved || search.revision >= saved.revision) byId.set(search.id, search);
  }
  const orphaned = !byId.has(local.id) && state.drafts[local.id] !== undefined && state.drafts[local.id] !== local.query;
  if (orphaned) {
    const retained = { ...local, status: 'unavailable' };
    delete retained.proposal;
    if (retained.draft) retained.draft = { ...retained.draft, taskId: null, status: 'interrupted' };
    byId.set(local.id, retained);
  }
  return { searches: [...byId.values()], authoritative: true, orphaned };
}
export type Action =
  | { type: "busy"; value: boolean }
  | { type: "loaded"; searches: Search[] }
  | { type: "restored"; searches: Search[]; saved: SavedWorkspaceState; preserveLocal: boolean; defaultSelection?: boolean; authoritative?: boolean }
  | { type: "submitted"; search: Search; previousId: string | null }
  | { type: "optionsSaved"; search: Search }
  | { type: "taskFailed"; id: string }
  | { type: "editing" }
  | { type: "query"; value: string }
  | { type: "select"; id: string | null }
  | { type: "new" }
  | { type: "status"; text: string; busy?: boolean }
  | { type: "proposal"; proposal: SearchProposal }
  | {
      type: "accepted";
      search: Search;
      submitted: string;
      previousId: string | null;
      confirmed?: boolean;
    }
  | { type: "deleted"; id: string };
export function workspaceReducer(state: Workspace, action: Action): Workspace {
  switch (action.type) {
    case "busy":
      return { ...state, busy: action.value };
    case "restored": {
      const merged = action.authoritative
        ? { ...state, searches: action.searches.filter(search => !state.deletedIds.has(search.id)) }
        : workspaceReducer(state, { type: "loaded", searches: action.searches });
      const drafts = { ...action.saved.drafts };
      for (const search of merged.searches)
        if (search.draft && drafts[search.id] === undefined) drafts[search.id] = search.draft.query;
      if (action.preserveLocal) Object.assign(drafts, state.drafts);
      const selectedId = action.preserveLocal ? state.selectedId
        : action.saved.activeSearchId ?? (action.defaultSelection && drafts.new === undefined ? merged.selectedId : null);
      const selected = merged.searches.find(search => search.id === selectedId);
      const query = drafts[draftKey(selectedId)] ?? selected?.query ?? "";
      const proposal = selected?.proposal && selected.proposal.expectedRevision === selected.revision && selected.proposal.query === query
        ? selected.proposal : null;
      return { ...merged, drafts, selectedId: selected?.id ?? null,
        proposal: action.preserveLocal && selected?.status !== "unavailable" && state.proposal?.query === query ? state.proposal : proposal };
    }
    case "submitted": {
      const drafts = { ...state.drafts }, key = draftKey(action.previousId);
      if (action.previousId === null) {
        drafts[action.search.id] = drafts.new ?? action.search.query;
        delete drafts.new;
      } else if (drafts[key] === undefined) drafts[key] = action.search.query;
      return { ...state, searches: [...state.searches.filter(search => search.id !== action.search.id), action.search], selectedId: action.search.id, drafts };
    }
    case "optionsSaved": {
      const previous = state.searches.find(search => search.id === action.search.id);
      if (!previous || previous.revision > action.search.revision) return state;
      const candidate = action.search.proposal;
      const query = state.drafts[draftKey(action.search.id)] ?? action.search.query;
      const proposal = candidate && candidate.searchId === action.search.id && candidate.expectedRevision === action.search.revision && candidate.query === query ? candidate : null;
      return { ...state, searches: state.searches.map(search => search.id === action.search.id ? action.search : search),
        proposal: state.selectedId === action.search.id ? proposal : state.proposal,
        status: state.selectedId === action.search.id ? "Posting languages saved." : state.status };
    }
    case "taskFailed":
      return { ...state, searches: state.searches.map(search => search.id === action.id && search.draft
        ? { ...search, draft: { ...search.draft, status: "failed" } } : search) };
    case "loaded": {
      const byId = new Map(
        action.searches
          .filter((search) => !state.deletedIds.has(search.id))
          .map((search) => [search.id, search]),
      );
      for (const local of state.searches) {
        const remote = byId.get(local.id);
        if (!remote || local.revision >= remote.revision)
          byId.set(local.id, local);
      }
      const searches = [...byId.values()];
      return {
        ...state,
        searches,
        selectedId:
          state.selectedId &&
          searches.some((search) => search.id === state.selectedId)
            ? state.selectedId
            : state.drafts.new !== undefined
              ? null
              : (searches.find((search) => search.status === "ready")?.id ??
                null),
      };
    }
    case "editing": {
      const key = draftKey(state.selectedId);
      // Claim the displayed draft before native text insertion can race hydration.
      return state.drafts[key] !== undefined
        ? state
        : { ...state, drafts: { ...state.drafts, [key]: queryText(state) } };
    }
    case "query":
      return {
        ...state,
        drafts: { ...state.drafts, [draftKey(state.selectedId)]: action.value },
        proposal: null,
      };
    case "select":
      return {
        ...state,
        selectedId: action.id,
        proposal: null,
        status: "",
        busy: false,
      };
    case "new":
      return {
        ...state,
        selectedId: null,
        drafts: { ...state.drafts, new: state.drafts.new ?? "" },
        proposal: null,
        status: "",
        busy: false,
      };
    case "status":
      return {
        ...state,
        status: action.text,
        ...(action.busy === undefined ? {} : { busy: action.busy }),
      };
    case "proposal":
      return { ...state, proposal: action.proposal, status: "", busy: false };
    case "accepted": {
      const drafts = { ...state.drafts },
        previousKey = draftKey(action.previousId);
      // Completing older work never discards text typed after its submission.
      const currentDraft = drafts[previousKey];
      if (currentDraft === undefined || currentDraft === action.submitted) {
        delete drafts[previousKey];
        delete drafts[action.search.id];
        if (currentDraft !== undefined && currentDraft !== action.search.query) drafts[action.search.id] = currentDraft;
      } else if (action.previousId === null) {
        drafts[action.search.id] = currentDraft;
        delete drafts.new;
      }
      return {
        ...state,
        searches: [
          ...state.searches.filter((search) => search.id !== action.search.id),
          action.search,
        ],
        selectedId: action.search.id,
        drafts,
        proposal: null,
        status: `${action.confirmed ? "Search saved with your confirmed limitations." : "Search saved."}${currentDraft !== undefined && currentDraft !== action.submitted ? " Your newer edits have not been applied." : ""}`,
        busy: false,
      };
    }
    case "deleted": {
      const searches = state.searches.filter(
          (search) => search.id !== action.id,
        ),
        drafts = { ...state.drafts },
        deletedIds = new Set([...state.deletedIds, action.id]);
      delete drafts[action.id];
      if (state.selectedId !== action.id)
        return { ...state, searches, drafts, deletedIds };
      return {
        ...state,
        searches,
        drafts,
        deletedIds,
        selectedId:
          state.selectedId === action.id
            ? (searches.find((search) => search.status === "ready")?.id ?? null)
            : state.selectedId,
        proposal: null,
        status: "",
        busy: false,
      };
    }
  }
}
