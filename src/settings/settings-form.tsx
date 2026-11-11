import { Div, Span } from "@k8slens/element-components";
import { PlainButton, TextInput } from "@k8slens/input-components";
import { useInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import { Callout, Checkbox, FieldLabel, Select } from "../ui/components";
import { defaultSettings, type Settings, settingsStoreInjectable } from "./settings.injectable";

const NumberField = ({ label, help, value, min, max, onChange }: { label: string; help?: string; value: number; min: number; max: number; onChange: (value: number) => void }) => (
  <FieldLabel label={label} help={help}>
    <Div $width={{ width: "8xl" }}>
      <TextInput
        type="number"
        aria-label={label}
        min={min}
        max={max}
        value={String(value)}
        onChange={(event) => {
          const next = Number(event.target.value);

          if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, Math.round(next))));
        }}
      />
    </Div>
  </FieldLabel>
);

/** The extension's settings. Cluster access is never configured here: it is always Lens's own, per cluster. */
export const SettingsForm = observer(({ clusterId }: { clusterId?: string }) => {
  const store = useInject(settingsStoreInjectable)();
  const settings = store.get();
  const update = (patch: Partial<Settings>) => store.update(patch);

  return (
    <Div $flex={{ direction: "vertical", gap: "l" }} $width={{ width: "full", max: "11xl" }} $style={{ maxWidth: 720 }}>
      <Callout level="info">The extension uses each cluster's connection and credentials from Lens. It never stores credentials; these settings hold only preferences.</Callout>

      <Div $flex={{ direction: "vertical", gap: "s" }}>
        <Span $font={{ bold: true }}>Safety</Span>
        <Checkbox checked={settings.readOnly} onChange={(readOnly) => update({ readOnly })} label="Read-only mode for every cluster (no creates, edits or deletes)" />
        {clusterId && (
          <Checkbox
            checked={settings.readOnlyClusters.includes(clusterId)}
            disabled={settings.readOnly}
            onChange={(readOnly) => store.setClusterReadOnly(clusterId, readOnly)}
            label="Read-only mode for this cluster only"
          />
        )}
        <Checkbox checked={settings.confirmDeleteByTyping} onChange={(confirmDeleteByTyping) => update({ confirmDeleteByTyping })} label="Require typing the name to confirm a deletion" />
        <FieldLabel label="Default way to save edits" help="Replace refuses a save when someone changed the resource since you read it; server-side apply merges and tracks field ownership.">
          <Div $width={{ width: "11xl" }}>
            <Select
              ariaLabel="Default way to save edits"
              value={settings.defaultWriteMode}
              options={[
                { value: "replace", label: "Replace (conflict-safe)" },
                { value: "server-side-apply", label: "Server-side apply" },
              ]}
              onChange={(defaultWriteMode) => update({ defaultWriteMode })}
            />
          </Div>
        </FieldLabel>
        <NumberField label="Backups kept per cluster" help="Manifests saved automatically before every update and deletion." value={settings.backupsToKeep} min={1} max={500} onChange={(backupsToKeep) => update({ backupsToKeep })} />
      </Div>

      <Div $flex={{ direction: "vertical", gap: "s" }}>
        <Span $font={{ bold: true }}>Reading the cluster</Span>
        <NumberField label="Refresh interval of status views (seconds, 0 = manual)" help="Resource lists are watched live regardless." value={settings.refreshSeconds} min={0} max={3600} onChange={(refreshSeconds) => update({ refreshSeconds })} />
        <FieldLabel label="Cilium namespace" help="Leave empty to find Cilium by its labels in any namespace.">
          <Div $width={{ width: "11xl" }}>
            <TextInput aria-label="Cilium namespace" placeholder="auto-detect" value={settings.ciliumNamespace} onChange={(event) => update({ ciliumNamespace: event.target.value.trim() })} />
          </Div>
        </FieldLabel>
        <NumberField label="Maximum nodes drawn in the topology" value={settings.topologyMaxNodes} min={50} max={5000} onChange={(topologyMaxNodes) => update({ topologyMaxNodes })} />
      </Div>

      <Div $flex={{ direction: "vertical", gap: "s" }}>
        <Span $font={{ bold: true }}>Hubble</Span>
        <FieldLabel label="Hubble Relay address" help="host:port as reached from inside a Cilium agent pod. Leave empty to use the hubble-relay Service of the namespace Relay runs in.">
          <Div $width={{ width: "11xl" }}>
            <TextInput aria-label="Hubble Relay address" placeholder="hubble-relay.kube-system.svc.cluster.local:80" value={settings.hubbleRelayAddress} onChange={(event) => update({ hubbleRelayAddress: event.target.value.trim() })} />
          </Div>
        </FieldLabel>
        <NumberField label="Flows read at most per query" value={settings.flowLimit} min={50} max={20000} onChange={(flowLimit) => update({ flowLimit })} />
      </Div>

      <Div>
        <PlainButton $onClick={() => update({ ...defaultSettings, readOnlyClusters: settings.readOnlyClusters })}>Restore the defaults</PlainButton>
      </Div>
    </Div>
  );
});
