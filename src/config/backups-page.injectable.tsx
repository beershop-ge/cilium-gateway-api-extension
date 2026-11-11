import { Div, Span } from "@k8slens/element-components";
import { DeleteIcon, FileDownloadIcon, HistoryIcon } from "@k8slens/icon";
import { getInjectable2 } from "@k8slens/injectable";
import { PlainButton, PrimaryButton } from "@k8slens/input-components";
import { useInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import { age } from "../common/format";
import { ciliumPageInjectionToken, type PageProps } from "../navigation/pages";
import { useViewState } from "../navigation/view-state.injectable";
import { ImportView } from "../resources/import-view";
import { type Backup, backupStoreInjectable } from "../settings/settings.injectable";
import { Callout, QueryView, useQueryState } from "../ui/components";
import { CodeView, downloadText } from "../ui/code-editor";
import { DataTable } from "../ui/data-table";
import { PageLayout } from "../ui/page-layout";
import { useClusterContext } from "../ui/use-cluster";

const BackupsPage = observer(({ clusterId, tabKey }: PageProps) => {
  const store = useInject(backupStoreInjectable)();
  const context = useClusterContext(clusterId);
  const query = context.queries.get("q:backups", () => store.list(clusterId));
  const state = useQueryState(query);
  const [selectedId, setSelectedId] = useViewState<string | undefined>(tabKey, "selected", undefined);
  const [restoring, setRestoring] = useViewState<Backup | undefined>(tabKey, "restoring", undefined);

  if (restoring) {
    return (
      <Div $height="full" $overflow="auto">
        <ImportView
          clusterId={clusterId}
          initialText={restoring.yaml}
          onClose={() => {
            setRestoring(undefined);
            void query.refresh();
          }}
        />
      </Div>
    );
  }

  return (
    <PageLayout
      clusterId={clusterId}
      title="Backups"
      subtitle="Manifests saved automatically before every update and deletion made from this extension, on this computer"
      actions={<PlainButton $onClick={() => void query.refresh()}>Refresh</PlainButton>}
    >
      <QueryView state={state}>
        {(backups) => {
          const selected = backups.find((backup) => backup.id === selectedId);

          return (
            <Div $flex={{ direction: "vertical", gap: "m" }} $padding={{ horizontal: "l", bottom: "l" }}>
              <Callout level="info">Restoring re-applies the saved manifest with a server-side apply, after a dry run and a diff against what the cluster holds now. Status and server fields are not part of a backup.</Callout>
              <DataTable<Backup>
                ariaLabel="Backups"
                rows={backups}
                rowKey={(backup) => backup.id}
                selectedKey={selectedId}
                onRowClick={(backup) => setSelectedId(backup.id === selectedId ? undefined : backup.id)}
                empty={<Span $color="textMuted" $padding="m" $block>No backups yet for this cluster.</Span>}
                columns={[
                  { id: "at", header: "When", render: (backup) => `${age(backup.at)} ago`, sortValue: (backup) => -new Date(backup.at).getTime() },
                  { id: "action", header: "Before", render: (backup) => backup.action, sortValue: (backup) => backup.action },
                  { id: "summary", header: "Resources", render: (backup) => <Span $font={{ size: "s" }}>{backup.summary}</Span> },
                ]}
              />
              {selected && (
                <Div $flex={{ direction: "vertical", gap: "s" }}>
                  <Div $flex={{ direction: "horizontal", gap: "s" }}>
                    <PrimaryButton Icon={HistoryIcon} $enabled={!context.isReadOnly()} $onClick={() => setRestoring(selected)}>
                      Restore…
                    </PrimaryButton>
                    <PlainButton Icon={FileDownloadIcon} $onClick={() => downloadText(`backup-${selected.at.replace(/[:.]/g, "-")}.yaml`, selected.yaml)}>
                      Download
                    </PlainButton>
                    <PlainButton
                      Icon={DeleteIcon}
                      $onClick={() => {
                        void store.remove(clusterId, selected.id).then(() => {
                          setSelectedId(undefined);
                          void query.refresh();
                        });
                      }}
                    >
                      Delete backup
                    </PlainButton>
                  </Div>
                  <CodeView value={selected.yaml} maxHeight={480} />
                </Div>
              )}
            </Div>
          );
        }}
      </QueryView>
    </PageLayout>
  );
});

export const backupsPageInjectable = getInjectable2({
  id: "cilium-ui-page-backups",
  injectionToken: ciliumPageInjectionToken,
  instantiate: () => () => ({
    id: "backups",
    section: "config" as const,
    title: "Backups",
    orderNumber: 80,
    Component: BackupsPage,
  }),
});

