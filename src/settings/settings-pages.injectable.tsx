import { Div } from "@k8slens/element-components";
import { getInjectable2 } from "@k8slens/injectable";
import { getExtensionPreferencePageInjectableBunch } from "@k8slens/preferences-contracts";
import packageJson from "../../package.json";
import { ciliumPageInjectionToken, type PageProps } from "../navigation/pages";
import { PageLayout } from "../ui/page-layout";
import { SettingsForm } from "./settings-form";

const SettingsPage = ({ clusterId }: PageProps) => (
  <PageLayout clusterId={clusterId} title="Extension Settings" subtitle="Preferences of Cilium Network Manager; also under Lens Preferences › Extensions">
    <Div $padding={{ horizontal: "l", bottom: "l" }}>
      <SettingsForm clusterId={clusterId} />
    </Div>
  </PageLayout>
);

export const settingsPageInjectable = getInjectable2({
  id: "cilium-ui-page-settings",
  injectionToken: ciliumPageInjectionToken,
  instantiate: () => () => ({
    id: "settings",
    section: "config" as const,
    title: "Extension Settings",
    orderNumber: 90,
    Component: SettingsPage,
  }),
});

const PreferencesBlock = () => <SettingsForm />;

export const settingsPreferencePage = getExtensionPreferencePageInjectableBunch({
  packageJson,
  blocks: [{ id: "settings", orderNumber: 10, Component: PreferencesBlock }],
});
