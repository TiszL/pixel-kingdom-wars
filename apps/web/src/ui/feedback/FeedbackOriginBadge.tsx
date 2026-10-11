/** Admin-only: which client sent a report (owner 2026-09-18 — Android-app reports
 * must be tellable apart from web ones at a glance). A display label derived from
 * spoofable headers; never a basis for points, trust or access. */
import { feedbackOrigin } from '@shardkeep/shared/feedback';
import { COLORS as C } from '../primitives';

export default function FeedbackOriginBadge({ context }: { context: unknown }): React.JSX.Element {
  const origin = feedbackOrigin(context), native = origin.client === 'android-native';
  return <span data-testid="origin-badge" data-client={origin.client} style={{ alignSelf: 'flex-start', fontSize: 14, padding: '2px 6px',
    border: `1px solid ${native ? C.success : C.borderLt}`, ...(native ? { background: C.success, color: C.ink } : { color: C.textDim }) }}>
    {origin.label.toUpperCase()}
  </span>;
}
