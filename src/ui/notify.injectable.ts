import { getInjectable2 } from "@k8slens/injectable";
import {
  showErrorNotificationInjectionToken,
  showInfoNotificationInjectionToken,
  showSuccessNotificationInjectionToken,
} from "@k8slens/notifications-contracts";
import { errorMessage } from "../common/json";
import { redactText } from "../common/redact";

export interface Notify {
  readonly success: (message: string) => void;
  readonly info: (message: string) => void;
  readonly error: (error: unknown, context?: string) => void;
}

/** Lens's own toasts, with error text redacted of anything secret-looking before it is shown. */
export const notifyInjectable = getInjectable2({
  id: "cilium-ui-notify",
  consumptions: [showSuccessNotificationInjectionToken, showInfoNotificationInjectionToken, showErrorNotificationInjectionToken],

  instantiate: (di) => {
    const showSuccess = di.inject(showSuccessNotificationInjectionToken)();
    const showInfo = di.inject(showInfoNotificationInjectionToken)();
    const showError = di.inject(showErrorNotificationInjectionToken)();

    const notify: Notify = {
      success: (message) => void showSuccess(message, { timeout: 5000 }),
      info: (message) => void showInfo(message, { timeout: 5000 }),
      error: (error, context) => void showError(redactText(context ? `${context}: ${errorMessage(error)}` : errorMessage(error))),
    };

    return () => notify;
  },
});
