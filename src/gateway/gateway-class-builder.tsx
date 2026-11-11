import { Div, Span } from "@k8slens/element-components";
import { observer } from "mobx-react";
import type { Json } from "../common/json";
import { itemsOf } from "../kube/snapshot";
import { Callout, FieldLabel, Section, Select } from "../ui/components";
import type { BuilderProps } from "./data";
import { MetadataFields } from "./common-builders";
import { Row, TextField, gatewayStyles } from "./fields";
import { ciliumControllerName, editField } from "./manifest";

const ciliumConfigGroup = "cilium.io";
const ciliumConfigKind = "CiliumGatewayClassConfig";

export const GatewayClassBuilder = observer(({ ctx, document, onChange, isNew }: BuilderProps) => {
  const controllerName: string = document?.spec?.controllerName ?? "";
  const parametersRef = document?.spec?.parametersRef as Json | undefined;
  const classConfigs = itemsOf(ctx.snapshot, ciliumConfigKind);
  const ciliumConfigInstalled = !ctx.snapshot.notInstalled.includes(ciliumConfigKind);
  const otherControllers = [...new Set(itemsOf(ctx.snapshot, "GatewayClass").map((item) => String(item.spec?.controllerName ?? "")).filter((name) => name && name !== ciliumControllerName))];
  const set = (path: (string | number)[], value: Json) => onChange(editField(document, path, value));

  return (
    <Div $flex={{ direction: "vertical", gap: "l" }}>
      <MetadataFields ctx={ctx} document={document} onChange={onChange} isNew={isNew} namespaced={false} />

      <Section title="Controller">
        <Row>
          <div className={gatewayStyles.medium}>
            <FieldLabel label="Known controllers">
              <Select
                ariaLabel="Known controllers"
                value={[ciliumControllerName, ...otherControllers].includes(controllerName) ? controllerName : undefined}
                placeholder="Custom"
                options={[{ value: ciliumControllerName, label: `Cilium (${ciliumControllerName})` }, ...otherControllers.map((name) => ({ value: name, label: name }))]}
                onChange={(value) => set(["spec", "controllerName"], value)}
              />
            </FieldLabel>
          </div>
          <TextField
            label="Controller name"
            required
            value={controllerName}
            readOnly={!isNew}
            help={isNew ? "The controller that implements Gateways of this class. It cannot be changed later." : "The controller name of a GatewayClass is immutable."}
            onChange={(value) => set(["spec", "controllerName"], value.trim())}
            issues={ctx.issues}
            path={["spec", "controllerName"]}
          />
        </Row>
        {controllerName && controllerName !== ciliumControllerName && (
          <Callout level="info">Cilium only programs Gateways whose class names {ciliumControllerName}. Another controller has to be running for this class to be accepted.</Callout>
        )}
      </Section>

      {ctx.features.gatewayClass.description.available && (
        <TextField label="Description" value={document?.spec?.description} onChange={(value) => set(["spec", "description"], value)} />
      )}

      <Section title="Parameters (optional)">
        <Span $color="textMuted" $font={{ size: "s" }}>
          Implementation-specific settings for every Gateway of this class.{" "}
          {ciliumConfigInstalled ? "Cilium reads them from a CiliumGatewayClassConfig." : "This cluster has no CiliumGatewayClassConfig CRD, so Cilium takes no parameters here."}
        </Span>
        {ciliumConfigInstalled && (
          <Row>
            <div className={gatewayStyles.medium}>
              <FieldLabel label="CiliumGatewayClassConfig">
                <Select
                  ariaLabel="CiliumGatewayClassConfig"
                  value={parametersRef?.kind === ciliumConfigKind ? `${parametersRef.namespace ?? ""}/${parametersRef.name}` : undefined}
                  placeholder={classConfigs.length ? "None" : "None exists yet"}
                  options={[
                    { value: "", label: "None" },
                    ...classConfigs.map((config) => ({ value: `${config.metadata.namespace ?? ""}/${config.metadata.name}`, label: `${config.metadata.namespace ? `${config.metadata.namespace}/` : ""}${config.metadata.name}` })),
                  ]}
                  onChange={(value) => {
                    if (!value) {
                      set(["spec", "parametersRef"], undefined);

                      return;
                    }

                    const [namespace, name] = value.split("/");

                    set(["spec", "parametersRef"], { group: ciliumConfigGroup, kind: ciliumConfigKind, name, ...(namespace ? { namespace } : {}) });
                  }}
                />
              </FieldLabel>
            </div>
          </Row>
        )}
        {parametersRef && parametersRef.kind !== ciliumConfigKind && (
          <Row>
            <TextField label="Group" value={parametersRef.group} onChange={(value) => set(["spec", "parametersRef", "group"], value)} />
            <TextField label="Kind" value={parametersRef.kind} onChange={(value) => set(["spec", "parametersRef", "kind"], value)} />
            <TextField label="Name" value={parametersRef.name} onChange={(value) => set(["spec", "parametersRef", "name"], value)} />
            <TextField label="Namespace" value={parametersRef.namespace} onChange={(value) => set(["spec", "parametersRef", "namespace"], value)} />
          </Row>
        )}
      </Section>
    </Div>
  );
});
