/** D-153.135: fixed service-purpose proof interface. No generic codec is public. */
export {createVehicleServiceBurnFinalityReader,makeVehicleBurnFinalityRpc,VehicleBurnFinalityError} from './vehicleBurnFinality';
export type {VehicleServiceBurnSavedReservation,VehicleBurnCoreTrust,VehicleBurnFinalityRpc,VehicleBurnOwnerAnchor} from './vehicleBurnFinality';
export {verifyVehicleServiceBurnEvidence,VehicleBurnEvidenceError} from './vehicleBurnEvidence';
export type {VehicleServiceBurnExpectation,VehicleServiceBurnEvidence} from './vehicleBurnEvidence';
