import { action, observable, runInAction } from "mobx";
import { errorMessage } from "./json";

export type QueryStatus = "idle" | "loading" | "ready" | "error";

export interface QueryState<T> {
  readonly status: QueryStatus;
  /** The last value that loaded; kept while a refresh runs or after a refresh fails. */
  readonly value?: T;
  readonly error?: Error;
  readonly loadedAt?: number;
  readonly refreshing: boolean;
}

export interface Query<T> {
  readonly state: () => QueryState<T>;
  /** Loads once, if nothing has loaded or is loading yet. */
  readonly ensure: () => void;
  /** Loads again, keeping the current value visible meanwhile. */
  readonly refresh: () => Promise<void>;
  /** Replaces the value without loading, after a write whose result is known. */
  readonly set: (value: T) => void;
}

/** One async value with its status, observable by MobX: what components render instead of suspending. */
export const createQuery = <T>(load: () => Promise<T>): Query<T> => {
  const state = observable.box<QueryState<T>>({ status: "idle", refreshing: false }, { deep: false });
  let running: Promise<void> | undefined;

  const refresh = () => {
    if (running) {
      return running;
    }

    runInAction(() => {
      const current = state.get();

      state.set({ ...current, status: current.value === undefined ? "loading" : current.status === "error" ? "error" : "ready", refreshing: true });
    });

    running = load().then(
      (value) => {
        runInAction(() => state.set({ status: "ready", value, loadedAt: Date.now(), refreshing: false }));
      },
      (error: unknown) => {
        runInAction(() => {
          const current = state.get();

          state.set({ ...current, status: "error", error: error instanceof Error ? error : new Error(errorMessage(error)), refreshing: false });
        });
      },
    ).finally(() => {
      running = undefined;
    });

    return running;
  };

  return {
    state: () => state.get(),
    ensure: () => {
      if (state.get().status === "idle") {
        void refresh();
      }
    },
    refresh,
    set: action((value: T) => state.set({ status: "ready", value, loadedAt: Date.now(), refreshing: false })),
  };
};

/** Queries cached by key, so every view asking for the same data shares one load. */
export const createQueryCache = () => {
  const queries = new Map<string, Query<unknown>>();

  return {
    get: <T>(key: string, load: () => Promise<T>): Query<T> => {
      let query = queries.get(key) as Query<T> | undefined;

      if (!query) {
        query = createQuery(load);
        queries.set(key, query as Query<unknown>);
      }

      return query;
    },
    invalidate: (prefix: string) => {
      for (const [key, query] of queries) {
        if (key.startsWith(prefix) && query.state().status !== "idle") {
          void query.refresh();
        }
      }
    },
  };
};

export type QueryCache = ReturnType<typeof createQueryCache>;
