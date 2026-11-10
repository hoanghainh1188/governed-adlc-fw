// Client data deletion commands (task H03c, design/ADR-M97 §2.4).
export {
  approveDeletion,
  cancelDeletion,
  DEFAULT_DELETION_LEGAL_BASIS,
  deletionStatus,
  derivePhase,
  listDeletionRequests,
  requestDeletion,
  type ClientDeletionPhase,
  type ClientDeletionView,
  type RequestDeletionInput,
} from './deletion.js';
