import { getInjectable2 } from "@k8slens/injectable";
import { getPersistableArrayInjectableBunch, getPersistableValueInjectableBunch } from "@k8slens/persistable-contracts";
import { action, computed, observable, runInAction } from "mobx";

/** What the extension keeps. Never credentials: cluster access is always Lens's own, per cluster. */
export interface Settings {
  readonly readOnly: boolean;
  readonly readOnlyClusters: readonly string[];
  /** How often composite views (topology, gateway map, status pages) read the cluster again; 0 turns it off. */
  readonly refreshSeconds: number;
  /** The namespace Cilium runs in; empty finds it by the agent's labels. */
  readonly ciliumNamespace: string;
  /** host:port of Hubble Relay as seen from inside an agent pod; empty derives it from the relay Service. */
  readonly hubbleRelayAddress: string;
  readonly flowLimit: number;
  readonly defaultWriteMode: "replace" | "server-side-apply";
  readonly confirmDeleteByTyping: boolean;
  readonly backupsToKeep: number;
  readonly topologyMaxNodes: number;
}

export const defaultSettings: Settings = {
  readOnly: false,
  readOnlyClusters: [],
  refreshSeconds: 20,
  ciliumNamespace: "",
  hubbleRelayAddress: "",
  flowLimit: 500,
  defaultWriteMode: "replace",
  confirmDeleteByTyping: true,
  backupsToKeep: 50,
  topologyMaxNodes: 400,
};

export const settingsBunch = getPersistableValueInjectableBunch<Settings>()({
  id: "settings",
  defaultValue: { instantiate: () => async () => defaultSettings },
});

export interface Backup {
  readonly id: string;
  readonly at: string;
  readonly action: string;
  readonly summary: string;
  readonly yaml: string;
}

export const backupsBunch = getPersistableArrayInjectableBunch<Backup, [clusterId: string]>()({
  id: "backups",
  defaultValue: { instantiate: () => async () => [] },
});

export interface SettingsStore {
  readonly get: () => Settings;
  readonly update: (patch: Partial<Settings>) => void;
  readonly isReadOnly: (clusterId: string) => boolean;
  readonly setClusterReadOnly: (clusterId: string, readOnly: boolean) => void;
}

/** The settings as a synchronous observable: defaults until what was persisted has loaded. */
export const settingsStoreInjectable = getInjectable2({
  id: "cilium-ui-settings-store",

  instantiate: (di) => {
    const getPersisted = di.inject(settingsBunch.persistable);
    const current = observable.box<Settings>(defaultSettings, { deep: false });
    let persisted: { get: () => Settings; set: (value: Settings) => void } | undefined;

    void getPersisted().then((box) => {
      persisted = box;
      runInAction(() => current.set({ ...defaultSettings, ...box.get() }));
    });

    const update = action((patch: Partial<Settings>) => {
      const next = { ...current.get(), ...patch };

      current.set(next);
      persisted?.set(next);
    });

    const store: SettingsStore = {
      get: () => current.get(),
      update,
      isReadOnly: (clusterId) => computed(() => current.get().readOnly || current.get().readOnlyClusters.includes(clusterId)).get(),
      setClusterReadOnly: (clusterId, readOnly) => {
        const others = current.get().readOnlyClusters.filter((id) => id !== clusterId);

        update({ readOnlyClusters: readOnly ? [...others, clusterId] : others });
      },
    };

    return () => store;
  },
});

export interface BackupStore {
  readonly list: (clusterId: string) => Promise<readonly Backup[]>;
  readonly add: (clusterId: string, backup: Omit<Backup, "id" | "at">) => Promise<void>;
  readonly remove: (clusterId: string, id: string) => Promise<void>;
}

/** Manifests saved automatically before every destructive change, per cluster, newest first. */
export const backupStoreInjectable = getInjectable2({
  id: "cilium-ui-backup-store",

  instantiate: (di) => {
    const getBackups = di.inject(backupsBunch.persistable);
    const getSettings = di.inject(settingsStoreInjectable);

    const store: BackupStore = {
      list: async (clusterId) => [...(await getBackups(clusterId))],
      add: async (clusterId, backup) => {
        const backups = await getBackups(clusterId);
        const keep = Math.max(1, getSettings().get().backupsToKeep);

        runInAction(() => {
          backups.unshift({ ...backup, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: new Date().toISOString() });

          if (backups.length > keep) {
            backups.splice(keep);
          }
        });
      },
      remove: async (clusterId, id) => {
        const backups = await getBackups(clusterId);
        const index = backups.findIndex((backup) => backup.id === id);

        if (index >= 0) {
          runInAction(() => backups.splice(index, 1));
        }
      },
    };

    return () => store;
  },
});
