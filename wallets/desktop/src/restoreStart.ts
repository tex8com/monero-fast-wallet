// Desktop adapter: keep existing imports stable while the actual restore
// policy is shared with the React Native wallet.
export {
  dateInputValue,
  isRestoreStartDateValid,
  parseRestoreStartDate,
  restoreHeightFromStartDate,
  todayRestoreDate,
  type RestoreNetwork,
} from '../../../packages/wallet-shared/src/restoreStart';
