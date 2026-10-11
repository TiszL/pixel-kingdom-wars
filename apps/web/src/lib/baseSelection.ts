/**
 * Add the device-selected stable base identity to a base-scoped request.
 * The server still verifies fresh ownership; this value never grants access.
 */
import { resolvePlotVersion } from '@shardkeep/shared';
import { useApp } from '../state/store';

export function withSelectedBase<T extends Record<string, unknown>>(
  body: T,
): T & { baseId?: string } {
  const { selectedBaseId: baseId, base } = useApp.getState();
  resolvePlotVersion(base?.plotVersion);
  return baseId ? { ...body, baseId } : body;
}

export function selectedBasePath(path: string): string {
  const baseId = useApp.getState().selectedBaseId;
  if (!baseId) return path;
  return `${path}${path.includes('?') ? '&' : '?'}baseId=${encodeURIComponent(baseId)}`;
}
