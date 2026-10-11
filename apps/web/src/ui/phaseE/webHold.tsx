import type { ComponentType } from 'react';
import { phaseEWebEnabled } from '../phaseEWebHold';
export { phaseEWebEnabled } from '../phaseEWebHold';

/** Server flags may serve native QA before the new web interface is admitted.
 * Only this explicit build opt-in may expose Phase E on web; absence fails closed. */
export function withPhaseEWebHold<Props extends object>(View: ComponentType<Props>) {
  return function PhaseEWebBoundary(props: Props): React.JSX.Element | null {
    return phaseEWebEnabled() ? <View {...props} /> : null;
  };
}
