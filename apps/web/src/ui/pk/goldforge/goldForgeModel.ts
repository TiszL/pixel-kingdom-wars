/**
 * Presentation types for the Gold Forge pure port at native 28609e71.
 * Shared kit primitives keep their existing web definitions. Kotlin enum names become
 * string unions; nullable fields stay nullable and constructor defaults are optional.
 * These formatted views do not establish server readiness or permission to spend.
 */
import type { BadgeUi, CommandState, MoneyStage, PriceUi, Verb } from '../types';

export interface GoldForgeTabUi {
  id: string;
  icon: string;
  label: string;
  badge: BadgeUi | null;
  locked: boolean;
}

export type HeroStatusKind = 'FORGING' | 'AT_REST' | 'RECONNECTING' | 'UNDER_CONSTRUCTION';
export interface HeroStatusUi {
  kind: HeroStatusKind;
  /** Already formatted time; default null, shown as an ellipsis. */
  time?: string | null;
  /** Server reason for AT_REST; default null. */
  reason?: string | null;
}
export interface HeroLine {
  text: string;
  emphasis: string | null;
  dot: Verb;
  spoken: string;
}

export type ForgeAction = 'SMELT' | 'FIND_RAID' | 'CLAIM' | 'CONTINUE' | 'RETRY' | 'BUY'
  | 'CONFIRM' | 'GET_GEMS' | 'EXPLAIN_LOCK' | 'NONE';
/** Selector outputs materialize every native default, including nulls and false flags. */
export interface ForgePrimaryLook {
  label: string;
  verb: Verb;
  state: CommandState;
  action: ForgeAction;
  sub: string | null;
  reason: string | null;
  icon: string | null;
  sentence: boolean;
  subAccent: boolean;
}

/** REFUSED requires an authoritative answer. Missing failure is treated as UNCERTAIN. */
export type MoneyFailure = 'REFUSED' | 'UNCERTAIN';
export type ClaimPhase = 'LOADING' | 'LOCKED' | 'READY' | 'COLLECTED' | 'ERROR';
export interface ClaimLockUi { date: string; reason: string | null }
export interface ClaimSealUi { amount: string; armedAtMs: number }
export interface ClaimUi {
  ready: string;
  readyDays: number | null;
  estimate: string | null;
  /** Wallet app name only; never an address. */
  walletLabel: string | null;
  /** For destination details only, never the main CLAIM face. */
  walletLast4: string | null;
  lock: ClaimLockUi | null;
  stage: MoneyStage;
  nextCoinsIn: string | null;
  canResumeSaved: boolean;
  /** Default READY. */
  phase?: ClaimPhase;
  /** Default null. */
  failure?: MoneyFailure | null;
  /** Default null. */
  seal?: ClaimSealUi | null;
}

export type GemsPhase = 'LOADING' | 'OFF' | 'READY' | 'ERROR';
export interface GemsSealUi { amount: string; pay: string; armedAtMs: number }
export interface GemsUi {
  rate: string;
  amount: string;
  pay: string;
  walletKeep: string;
  walletAfter: string;
  quick: readonly string[];
  selectedQuick: string | null;
  min: string;
  max: string;
  short: string | null;
  shortfallFor: string | null;
  stage: MoneyStage;
  pendingRecovery: boolean;
  toShardsAvailable: boolean;
  swapOffered: boolean;
  /** Default READY. */
  phase?: GemsPhase;
  /** Default null. */
  offReason?: string | null;
  /** Default null. */
  failure?: MoneyFailure | null;
  /** Default false. */
  walletShort?: boolean;
  /** Default null. */
  seal?: GemsSealUi | null;
}

export type GemSpendKind = 'FINISH' | 'BUY' | 'SKIP';
export interface GemSpendUi {
  kind: GemSpendKind;
  title: string;
  subjectArt: string;
  subjectName: string;
  subjectLine: string;
  progress: number | null;
  timeLeft: string | null;
  price: PriceUi;
  have: string;
  after: string | null;
  short: string | null;
  quotedAtMs: number;
  stage: MoneyStage;
  /** Default quotedAtMs; consumers normalize before passing to the shared Seal. */
  armedAtMs?: number;
  /** Default null. */
  failure?: MoneyFailure | null;
  /** Default null. */
  unavailableReason?: string | null;
}

export type SmeltState = 'LOADING' | 'CHOOSING' | 'REVIEW' | 'SENDING' | 'HELD' | 'QUALIFIED'
  | 'PAUSED' | 'NOT_READY' | 'ERROR';
/** Native Int presentation quantities only; transport quantities must remain exact in the adapter. */
export interface SmeltTileUi {
  resourceId: string;
  icon: string;
  have: string;
  chosen: number;
  unitValue: string;
  source: string;
  /** Default empty string. */
  name?: string;
  /** Default true. */
  canAdd?: boolean;
}
export interface LoadText { basket: string | null; rest: string }
export type StepState = 'DONE' | 'NOW' | 'TODO';
