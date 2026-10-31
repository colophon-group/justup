// Pure workspace transitions keep accepted criteria separate from unsubmitted drafts.
import type { Search, SearchProposal } from "../../api/types.ts";
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
export type Action =
  | { type: "busy"; value: boolean }
  | { type: "loaded"; searches: Search[] }
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
        drafts: { ...state.drafts, new: "" },
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
