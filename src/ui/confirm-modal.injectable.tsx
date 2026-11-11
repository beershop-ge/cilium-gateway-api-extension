import { Div, P, Span } from "@k8slens/element-components";
import { WarningIcon } from "@k8slens/icon";
import { getInjectable2 } from "@k8slens/injectable";
import { DangerButton, PlainButton, PrimaryButton, TextInput } from "@k8slens/input-components";
import { ModalContainer, ModalContent, ModalFooter, ModalHeader } from "@k8slens/modal-components";
import { getModalInjectableBunch, getModalKind, type ModalProps, openModalInjectionToken, useRespondFromModal } from "@k8slens/modal-contracts";
import { useState } from "react";
import type { Risk } from "../common/risk";
import { Callout } from "./components";

export interface ConfirmRequest {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly danger?: boolean;
  /** When set, the user types this to confirm, so a destructive action cannot be taken by a stray click. */
  readonly typeToConfirm?: string;
  readonly risks?: readonly Risk[];
  readonly details?: readonly string[];
}

export const confirmModalKind = getModalKind<[request: ConfirmRequest], boolean>()("confirm");

const ConfirmModal = ({ input: [request] }: ModalProps<typeof confirmModalKind>) => {
  const respond = useRespondFromModal(confirmModalKind);
  const [typed, setTyped] = useState("");
  const confirmed = !request.typeToConfirm || typed === request.typeToConfirm;
  const Confirm = request.danger ? DangerButton : PrimaryButton;

  return (
    <ModalContainer $style={{ width: "calc(var(--unit) * 140)", maxWidth: "90vw" }}>
      <ModalHeader icon={request.danger ? <WarningIcon /> : undefined} onClose={() => respond(false)}>
        {request.title}
      </ModalHeader>
      <ModalContent>
        <Div $flex={{ direction: "vertical", gap: "m" }}>
          <P>{request.message}</P>
          {request.details && request.details.length > 0 && (
            <Div $flex={{ direction: "vertical", gap: "xxs" }}>
              {request.details.map((detail) => (
                <Span key={detail} $font={{ size: "s" }} $color="textMuted">
                  • {detail}
                </Span>
              ))}
            </Div>
          )}
          {(request.risks ?? []).map((risk, index) => (
            <Callout key={index} level={risk.level === "danger" ? "danger" : risk.level === "warning" ? "warning" : "info"}>
              {risk.message}
            </Callout>
          ))}
          {request.typeToConfirm && (
            <Div $flex={{ direction: "vertical", gap: "xs" }}>
              <Span $font={{ size: "s" }}>
                Type <b>{request.typeToConfirm}</b> to confirm.
              </Span>
              <TextInput
                aria-label="Confirmation"
                value={typed}
                autoFocus
                onChange={(event) => setTyped(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && confirmed) respond(true);
                }}
              />
            </Div>
          )}
        </Div>
      </ModalContent>
      <ModalFooter>
        <PlainButton onClick={() => respond(false)}>Cancel</PlainButton>
        <Confirm $enabled={confirmed} onClick={() => respond(true)}>
          {request.confirmLabel}
        </Confirm>
      </ModalFooter>
    </ModalContainer>
  );
};

export default getModalInjectableBunch({
  kind: confirmModalKind,
  Component: ConfirmModal,
  onClose: () => false,
});

/** Asks the user to confirm, resolving true only when they do. */
export const confirmInjectable = getInjectable2({
  id: "cilium-ui-confirm",
  consumptions: [openModalInjectionToken],

  instantiate: (di) => {
    const openConfirm = di.inject(openModalInjectionToken.for(confirmModalKind).for(di.scopeIds))();

    return () => (request: ConfirmRequest) => openConfirm(request);
  },
});
