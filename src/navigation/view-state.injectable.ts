import { getInjectable2 } from "@k8slens/injectable";
import { useInject } from "@k8slens/use-inject";
import { action, observable, type ObservableMap } from "mobx";

/**
 * Per-tab view state (search, filters, selection, open editor) kept while Lens runs, so switching
 * tabs and coming back finds a page as it was left.
 */
export const viewStateInjectable = getInjectable2({
  id: "cilium-ui-view-state",

  instantiate: () => {
    const states = new Map<string, ObservableMap<string, unknown>>();

    return () => (key: string) => {
      let state = states.get(key);

      if (!state) {
        state = observable.map<string, unknown>({}, { deep: false });
        states.set(key, state);
      }

      return state;
    };
  },
});

/** Reads and writes one field of a tab's view state; the component must be an `observer`. */
export const useViewState = <T>(key: string, field: string, initial: T): [T, (value: T) => void] => {
  const state = useInject(viewStateInjectable)()(key);
  const value = state.has(field) ? (state.get(field) as T) : initial;

  return [value, action((next: T) => state.set(field, next))];
};
