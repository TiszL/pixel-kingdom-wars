import {
  buildPhaseECatalogue, PhaseECatalogueResponseSchema, type PhaseECatalogueResponse,
} from '@shardkeep/shared/phaseE';
import { phaseECatalogEnabled } from '../config';
import { HttpError } from '../lib/errors';

/** D-151 implements a policy read only. No player, database or chain inputs:
 * reading future rules must never create a base or activate value movement. */
export function getPhaseECatalogue(): PhaseECatalogueResponse {
  if (!phaseECatalogEnabled()) {
    throw new HttpError(503, 'Phase E catalogue is not enabled', 'PHASE_E_DISABLED');
  }
  return PhaseECatalogueResponseSchema.parse(buildPhaseECatalogue());
}
