import { useCallback, useEffect, useReducer, useRef } from "react";
import { ApiError, errorText, isAbortError } from "../../api/client.ts";
import type { ApiClient } from "../../api/client.ts";
import { pollTask, TaskFailure } from "../../api/tasks.ts";
import type { SearchSubmission, Session } from "../../api/types.ts";
import {
  emptyWorkspace,
  queryText,
  selectedSearch,
  workspaceReducer,
} from "./workspace.ts";
interface Mutation {
  key: string;
  submission?: SearchSubmission;
}
export function useWorkspace(
  client: ApiClient,
  session: Session | null,
  onSignIn: () => void,
) {
  const [state, dispatch] = useReducer(
    workspaceReducer,
    undefined,
    emptyWorkspace,
  );
  const current = useRef(state);
  current.current = state;
  const operation = useRef<{
    controller: AbortController;
    token: symbol;
  } | null>(null);
  const mutations = useRef(new Map<string, Mutation>()),
    confirmationKeys = useRef(new Map<string, string>());
  const cancel = useCallback(() => {
    operation.current?.controller.abort();
    operation.current = null;
  }, []);
  const userId = session?.user?.id;
  useEffect(() => {
    const controller = new AbortController();
    if (userId)
      client
        .listSearches(controller.signal)
        .then((searches) => {
          if (!controller.signal.aborted)
            dispatch({ type: "loaded", searches });
        })
        .catch((error) => {
          if (!isAbortError(error))
            dispatch({
              type: "status",
              text: `Saved searches unavailable. ${errorText(error)}`,
            });
        });
    return () => {
      controller.abort();
      cancel();
    };
  }, [client, userId, cancel]);
  useEffect(() => () => cancel(), [cancel]);
  const select = (id: string | null) => {
    cancel();
    dispatch({ type: "select", id });
  };
  const newSearch = () => {
    cancel();
    dispatch({ type: "new" });
  };
  const submit = async () => {
    if (!session) return;
    if (!session.user) {
      onSignIn();
      return;
    }
    if (!session.capabilities.search) {
      dispatch({
        type: "status",
        text: "Search interpretation is unavailable right now. Your accepted searches remain available.",
      });
      return;
    }
    const snapshot = current.current,
      search = selectedSearch(snapshot),
      submittedText = queryText(snapshot),
      query = submittedText.trim();
    if (!query) return;
    cancel();
    const active = {
      controller: new AbortController(),
      token: Symbol("submission"),
    };
    operation.current = active;
    const fingerprint = JSON.stringify([
      search?.id ?? null,
      search?.revision ?? null,
      query,
    ]);
    const mutation = mutations.current.get(fingerprint) ?? {
      key: crypto.randomUUID(),
    };
    mutations.current.set(fingerprint, mutation);
    dispatch({
      type: "status",
      text: "Checking every requirement…",
      busy: true,
    });
    try {
      mutation.submission ??= search
        ? await client.editSearch(
            search.id,
            {
              query,
              expectedRevision: search.revision,
              requestKey: mutation.key,
            },
            active.controller.signal,
          )
        : await client.createSearch(
            { query, requestKey: mutation.key },
            active.controller.signal,
          );
      if (active !== operation.current) return;
      if (search && mutation.submission.search.id !== search.id)
        throw new ApiError(
          409,
          "unexpected_search",
          "The service returned a different search. Please reconnect.",
        );
      const result = mutation.submission.task
        ? await pollTask(
            client,
            mutation.submission.task.id,
            active.controller.signal,
          )
        : { search: mutation.submission.search };
      if (active !== operation.current) return;
      if ("proposal" in result) {
        if (
          result.proposal.searchId !== mutation.submission.search.id ||
          result.proposal.expectedRevision !==
            (search?.revision ?? mutation.submission.search.revision)
        )
          throw new ApiError(
            409,
            "unexpected_proposal",
            "The service returned an outdated proposal. Please retry.",
          );
        // New typing invalidates a proposal for the earlier text.
        if (queryText(current.current).trim() === query)
          dispatch({ type: "proposal", proposal: result.proposal });
        else
          dispatch({
            type: "status",
            text: "The earlier search needs clarification. Submit your updated text to continue.",
            busy: false,
          });
      } else if ("search" in result) {
        if (
          result.search.id !== mutation.submission.search.id ||
          result.search.status !== "ready" ||
          result.search.query !== query ||
          (search && result.search.revision <= search.revision)
        )
          throw new ApiError(
            409,
            "unexpected_revision",
            "The service returned an unexpected search revision. Please reconnect.",
          );
        mutations.current.delete(fingerprint);
        dispatch({
          type: "accepted",
          search: result.search,
          submitted: submittedText,
          previousId: snapshot.selectedId,
        });
      } else throw new Error("The search task returned an unrelated result.");
    } catch (error) {
      if (active !== operation.current || isAbortError(error)) return;
      if (error instanceof TaskFailure) mutations.current.delete(fingerprint);
      dispatch({
        type: "status",
        text: `${errorText(error)}${search ? " The last accepted revision and its results are unchanged." : ""}`,
        busy: false,
      });
    } finally {
      if (active === operation.current) {
        operation.current = null;
        dispatch({ type: "busy", value: false });
      }
    }
  };
  const confirm = async () => {
    const proposal = current.current.proposal;
    if (!proposal) return;
    cancel();
    const active = {
      controller: new AbortController(),
      token: Symbol("confirmation"),
    };
    operation.current = active;
    const confirmationId = `${proposal.proposalId}:${proposal.expectedRevision}`;
    const confirmationKey =
      confirmationKeys.current.get(confirmationId) ?? crypto.randomUUID();
    confirmationKeys.current.set(confirmationId, confirmationKey);
    dispatch({ type: "status", text: "", busy: true });
    try {
      const accepted = await client.confirmSearch(
        proposal.searchId,
        {
          proposalId: proposal.proposalId,
          expectedRevision: proposal.expectedRevision,
        },
        confirmationKey,
        active.controller.signal,
      );
      if (active !== operation.current) return;
      if (
        accepted.id !== proposal.searchId ||
        accepted.revision <= proposal.expectedRevision ||
        accepted.status !== "ready"
      )
        throw new Error(
          "The service returned an unexpected confirmed revision.",
        );
      confirmationKeys.current.delete(confirmationId);
      dispatch({
        type: "accepted",
        search: accepted,
        submitted: proposal.query,
        previousId: current.current.selectedId,
        confirmed: true,
      });
    } catch (error) {
      if (active === operation.current && !isAbortError(error))
        dispatch({
          type: "status",
          text: `${errorText(error)} The last accepted search is unchanged.`,
          busy: false,
        });
    } finally {
      if (active === operation.current) operation.current = null;
    }
  };
  const remove = async (id: string) => {
    await client.deleteSearch(id);
    if (current.current.selectedId === id) cancel();
    dispatch({ type: "deleted", id });
  };
  return {
    state,
    search: selectedSearch(state),
    query: queryText(state),
    beginEditing: () => dispatch({ type: "editing" }),
    setQuery: (value: string) => dispatch({ type: "query", value }),
    submit,
    confirm,
    select,
    newSearch,
    remove,
  };
}
