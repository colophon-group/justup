import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ApiError, errorText, isAbortError } from "../../api/client.ts";
import type { ApiClient } from "../../api/client.ts";
import { pollTask, TaskFailure } from "../../api/tasks.ts";
import type { Search, SearchSubmission, Session, TaskResult } from "../../api/types.ts";
import {
  emptyWorkspace,
  queryText,
  selectedSearch,
  workspaceReducer,
} from "./workspace.ts";
import type { Action } from "./workspace.ts";
import { useWorkspacePersistence } from "./useWorkspacePersistence.ts";
interface Mutation {
  key: string;
  submission?: SearchSubmission;
  attempted?: boolean;
}
interface Operation { controller: AbortController; token: symbol }
export function useWorkspace(
  client: ApiClient,
  session: Session | null,
  onVisitorRebootstrap: () => Promise<void>,
) {
  const [state, dispatch] = useReducer(
    workspaceReducer,
    undefined,
    emptyWorkspace,
  );
  const current = useRef(state);
  current.current = state;
  const serial = useRef(0);
  const [accountSuggested, setAccountSuggested] = useState(false);
  const apply = useCallback((action: Action) => {
    if (["editing", "query", "select", "new", "accepted", "submitted", "deleted"].includes(action.type)) serial.current++;
    current.current = workspaceReducer(current.current, action);
    dispatch(action);
  }, []);
  const operation = useRef<Operation | null>(null);
  const resumedTasks = useRef(new Set<string>());
  const mutations = useRef(new Map<string, Mutation>()),
    confirmationKeys = useRef(new Map<string, string>());
  const cancel = useCallback(() => {
    operation.current?.controller.abort();
    operation.current = null;
  }, []);
  const userId = session?.user?.id;
  const scope = session?.user ? "account" : session?.capabilities.visitorSearch ? "visitor" : null;
  const persistence = useWorkspacePersistence({ client, scope, owner: userId, hasVisitor: !!session?.visitor, onVisitorRebootstrap, state, current, serial, apply });
  useEffect(() => {
    mutations.current.clear();
    confirmationKeys.current.clear();
    resumedTasks.current.clear();
    setAccountSuggested(false);
    return cancel;
  }, [userId, scope, cancel]);
  useEffect(() => () => cancel(), [cancel]);
  const select = (id: string | null) => {
    cancel();
    apply({ type: "select", id });
  };
  const newSearch = () => {
    cancel();
    apply({ type: "new" });
  };
  const applyResult = useCallback((active: Operation, result: TaskResult, targetId: string, expectedRevision: number, submitted: string, previousId: string | null) => {
    if (active !== operation.current) return;
    const query = submitted.trim();
    if ("proposal" in result) {
      if (result.proposal.searchId !== targetId || result.proposal.expectedRevision !== expectedRevision)
        throw new ApiError(409, "unexpected_proposal", "The service returned an outdated proposal. Please retry.");
      if (queryText(current.current).trim() === query) apply({ type: "proposal", proposal: result.proposal });
      else apply({ type: "status", text: "The earlier search needs clarification. Submit your updated text to continue.", busy: false });
    } else if ("search" in result) {
      if (result.search.id !== targetId || result.search.status !== "ready" || result.search.query !== query || result.search.revision <= expectedRevision)
        throw new ApiError(409, "unexpected_revision", "The service returned an unexpected search revision. Please reconnect.");
      apply({ type: "accepted", search: result.search, submitted, previousId });
    } else throw new Error("The search task returned an unrelated result.");
  }, [apply]);
  const resume = useCallback(async (search: Search) => {
    const draft = search.draft;
    if (!scope || !draft?.taskId) return;
    cancel();
    const active = { controller: new AbortController(), token: Symbol("resumed search") };
    operation.current = active; resumedTasks.current.add(draft.taskId);
    const displayed = queryText(current.current);
    const submitted = displayed.trim() === draft.query ? displayed : draft.query;
    apply({ type: "status", text: "Checking the existing search…", busy: true });
    try {
      const result = await pollTask(client, draft.taskId, active.controller.signal, scope);
      applyResult(active, result, search.id, search.revision, submitted, search.id);
    } catch (error) {
      if (active === operation.current && !isAbortError(error)) {
        if (error instanceof TaskFailure) apply({ type: "taskFailed", id: search.id });
        apply({ type: "status", text: errorText(error), busy: false });
      }
    } finally {
      if (active === operation.current) { operation.current = null; apply({ type: "busy", value: false }); }
    }
  }, [client, scope, cancel, apply, applyResult]);
  const submit = async () => {
    if (!session || !scope || !session.capabilities.search) {
      apply({
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
    if (search?.draft?.taskId && search.draft.query === query && !["interrupted", "failed"].includes(search.draft.status ?? "")) {
      await resume(search); return;
    }
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
    apply({
      type: "status",
      text: "Checking every requirement…",
      busy: true,
    });
    try {
      if (search || !mutation.attempted) await persistence.flush(active.controller.signal);
      if (active !== operation.current) return;
      mutation.attempted = true;
      mutation.submission ??= search
        ? await client.editSearch(
            search.id,
            {
              query,
              expectedRevision: search.revision,
              requestKey: mutation.key,
            },
            active.controller.signal,
            scope,
          )
        : await client.createSearch(
            { query, requestKey: mutation.key },
            active.controller.signal,
            scope,
          );
      if (active !== operation.current) return;
      if (search && mutation.submission.search.id !== search.id)
        throw new ApiError(409, "unexpected_search", "The service returned a different search. Please reconnect.");
      if (mutation.submission.task) {
        resumedTasks.current.add(mutation.submission.task.id);
        apply({ type: "submitted", search: { ...mutation.submission.search, draft: { query, taskId: mutation.submission.task.id } }, previousId: snapshot.selectedId });
      } else if (!search && mutation.submission.search.status !== "ready") {
        apply({ type: "submitted", search: mutation.submission.search, previousId: snapshot.selectedId });
        mutations.current.set(JSON.stringify([mutation.submission.search.id, mutation.submission.search.revision, query]), mutation);
      }
      if (!search) {
        if (!mutation.submission.task && mutation.submission.search.status === "ready") apply({ type: "submitted", search: mutation.submission.search, previousId: snapshot.selectedId });
        await persistence.refreshAfterCreate({ id: mutation.submission.search.id, submitted: submittedText });
        if (active !== operation.current) return;
      }
      const result = mutation.submission.task
        ? await pollTask(
            client,
            mutation.submission.task.id,
            active.controller.signal,
            scope,
          )
        : { search: mutation.submission.search };
      if (active !== operation.current) return;
      applyResult(active, result, mutation.submission.search.id, search?.revision ?? 0, submittedText,
        search?.id ?? mutation.submission.search.id);
      if ("search" in result)
        for (const [key, value] of mutations.current) if (value === mutation) mutations.current.delete(key);
    } catch (error) {
      if (active !== operation.current || isAbortError(error)) return;
      if (!search && mutation.attempted && !mutation.submission && error instanceof ApiError && (error.status === 0 || error.status >= 500 || error.code === "invalid_response")) {
        await persistence.refreshAfterCreate();
        if (active !== operation.current) return;
      }
      if (error instanceof TaskFailure) {
        for (const [key, value] of mutations.current) if (value === mutation) mutations.current.delete(key);
        if (mutation.submission) apply({ type: "taskFailed", id: mutation.submission.search.id });
      }
      if (scope === "visitor" && error instanceof ApiError && error.code === "task_limit") setAccountSuggested(true);
      apply({
        type: "status",
        text: `${errorText(error)}${search ? " The last accepted revision and its results are unchanged." : ""}`,
        busy: false,
      });
    } finally {
      if (active === operation.current) {
        operation.current = null;
        apply({ type: "busy", value: false });
      }
    }
  };
  const confirm = async () => {
    const proposal = current.current.proposal;
    if (!proposal || !scope) return;
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
    apply({ type: "status", text: "", busy: true });
    try {
      await persistence.flush(active.controller.signal);
      if (active !== operation.current) return;
      const accepted = await client.confirmSearch(
        proposal.searchId,
        {
          proposalId: proposal.proposalId,
          expectedRevision: proposal.expectedRevision,
        },
        confirmationKey,
        active.controller.signal,
        scope,
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
      apply({
        type: "accepted",
        search: accepted,
        submitted: proposal.query,
        previousId: current.current.selectedId,
        confirmed: true,
      });
    } catch (error) {
      if (active === operation.current && !isAbortError(error))
        apply({
          type: "status",
          text: `${errorText(error)} The last accepted search is unchanged.`,
          busy: false,
        });
    } finally {
      if (active === operation.current) operation.current = null;
    }
  };
  const remove = async (id: string) => {
    if (!scope) throw new Error("Reconnect before changing saved searches.");
    await persistence.flush();
    await client.deleteSearch(id, undefined, scope);
    if (current.current.selectedId === id) cancel();
    apply({ type: "deleted", id });
  };
  const flushForAuthentication = useCallback(async (signal?: AbortSignal) => {
    if (!scope && queryText(current.current).trim())
      throw new Error("Search storage is unavailable. Reconnect before signing in to keep this draft.");
    await persistence.flush(signal);
  }, [scope, persistence.flush]);
  const selected = selectedSearch(state);
  useEffect(() => {
    const taskId = selected?.draft?.taskId;
    if (!persistence.loading && selected && taskId && !selected.proposal && !operation.current
      && !["interrupted", "failed"].includes(selected.draft?.status ?? "") && !resumedTasks.current.has(taskId)) void resume(selected);
  }, [selected?.id, selected?.revision, selected?.draft?.taskId, selected?.proposal, persistence.loading, resume]);
  return {
    ...persistence,
    flush: flushForAuthentication,
    recover: async (draftId: string, action: "use" | "discard") => {
      cancel(); apply({ type: "busy", value: false });
      return persistence.recover(draftId, action);
    },
    resolveConflict: (choice: "local" | "saved") => {
      cancel(); apply({ type: "busy", value: false });
      persistence.resolveConflict(choice);
    },
    scope,
    accountSuggested,
    state,
    search: selectedSearch(state),
    query: queryText(state),
    beginEditing: () => apply({ type: "editing" }),
    setQuery: (value: string) => apply({ type: "query", value }),
    submit,
    confirm,
    select,
    newSearch,
    remove,
  };
}
