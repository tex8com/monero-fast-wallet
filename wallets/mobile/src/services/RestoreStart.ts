// Mobile adapter: preserve the public service module while sharing exactly
// the same safe restore-start policy with the desktop wallet.
export {
  dateInputValue,
  isRestoreStartDateValid,
  parseRestoreStartDate,
  restoreHeightFromStartDate,
  todayRestoreDate,
  type RestoreNetwork,
} from '../../../../packages/wallet-shared/src/restoreStart';
