import {
  productLanguageCodes,
  productLocaleByCode,
  type ProductLanguageCode,
} from '../../../../config/productLocales';
import {
  generatedRuntimeCatalogLoaders,
  type GeneratedRuntimeCatalog,
} from './lazy.generated';

const en = {
  'action.addWallet': 'Add Wallet',
  'action.back': 'Back',
  'action.cancel': 'Cancel',
  'action.enableNotifications': 'Enable alerts',
  'action.clear': 'Clear',
  'action.close': 'Close',
  'action.closeWallet': 'Close wallet',
  'action.continue': 'Continue',
  'action.delete': 'Delete',
  'action.getStarted': 'Get Started',
  'action.copyAddress': 'Copy address',
  'action.copied': 'Copied',
  'action.create': 'Create',
  'action.createIdentity': 'Create Identity',
  'action.createWallet': 'Create Wallet',
  'action.import': 'Import',
  'action.open': 'Open',
  'action.openWallet': 'Open Wallet',
  'action.paste': 'Paste',
  'action.prepareSend': 'Prepare Send',
  'action.reconnect': 'Reconnect',
  'action.retry': 'Try again',
  'action.reset': 'Reset',
  'action.runDiagnostics': 'Run Diagnostics',
  'action.save': 'Save',
  'action.change': 'Change',
  'action.saving': 'Saving',
  'action.search': 'Search',
  'action.sendNow': 'Send Now',
  'action.share': 'Share',
  'action.shared': 'Shared',
  'action.showOnLedger': 'Show on Ledger',
  'action.unlock': 'Unlock',
  'action.working': 'Working...',
  'common.off': 'Off',
  'common.on': 'On',
  'common.optional': 'Optional',
  'common.required': 'Required',
  'common.wallet': 'Wallet',
  'native.notification.transactions': 'Monero transactions',
  'native.notification.transactionsDescription':
    'Fast Wallet payment and confirmation alerts',
  'native.notification.sync': 'Wallet synchronization',
  'native.notification.syncDescription':
    'Keeps active wallet history synchronization running',
  'native.notification.syncTitle': 'Synchronizing wallet history',
  'native.notification.syncBody':
    'Downloading and scanning public blockchain data',
  'native.permission.location':
    'Location is used only when you enable nearby Monero Enthusiast discovery. The app reduces it to an approximate area and never displays your exact position.',
  'native.permission.bluetooth':
    'Bluetooth is used to connect to Ledger Nano hardware wallets.',
  'native.permission.camera':
    'Camera access is used only to scan a Monero receiving-address QR code.',
  'native.permission.faceId':
    'Face ID is used to unlock Monero Fast Wallet securely on this device.',
  'language.de': 'Deutsch',
  'language.en': 'English',
  'tabs.home': 'Home',
  'tabs.community': 'Community',
  'tabs.menu': 'Menu',
  'tabs.receive': 'Receive',
  'tabs.send': 'Send',
  'topBar.connecting': 'Connecting',
  'topBar.connectingBlocks': 'Connecting block sync',
  'topBar.connectingTor': 'Connecting to Tor',
  'topBar.offline': 'Offline',
  'topBar.online': 'Online',
  'topBar.ready': 'Ready',
  'communityV1.title': 'Monero Enthusiast',
  'communityV1.menuDescription':
    'Coming soon: connect, chat, and share services',
  'vanity.title': 'Vanity Address',
  'vanity.subtitle': 'Create a private custom Monero address',
  'communitySoon.eyebrow': 'Coming soon',
  'communitySoon.title': 'Monero Community',
  'communitySoon.subtitle':
    'A private place to connect around Monero — without turning the wallet into a marketplace.',
  'communitySoon.plannedFeatures': 'Planned features',
  'communitySoon.bulletinTitle': 'Bulletin board',
  'communitySoon.bulletinText':
    'Share announcements, ideas, questions, and local meetups.',
  'communitySoon.meetTitle': 'Meet people',
  'communitySoon.meetText':
    'Get to know people nearby, arrange a meeting, or connect online.',
  'communitySoon.matrixTitle': 'Matrix chat',
  'communitySoon.matrixText':
    'Keep conversations in one integrated, private Matrix chat.',
  'communitySoon.profilesTitle': 'Profiles and services',
  'communitySoon.profilesText':
    'Create a profile and describe services you offer. Direct contact stays between users.',
  'communitySoon.verifiedTitle': 'Optional verification',
  'communitySoon.verifiedText':
    'Verified users receive a visible badge to help reduce impersonation and scam risk. Verification remains optional.',
  'communitySoon.verifiedNote': 'The badge is a trust signal, not a guarantee.',
  'communitySoon.verifiedBadge': 'Verified',
  'communitySoon.noMarketplaceTitle': 'No marketplace',
  'communitySoon.noMarketplaceText':
    'For regulatory reasons, the app will not provide a marketplace, checkout, or intermediary trading. Users can still present their own services in their profiles.',
  'communityV1.optional': 'Optional community',
  'communityV1.subtitle':
    'Discover people and useful ideas without connecting them to your wallet.',
  'communityV1.walletSeparate': 'Your wallet stays separate',
  'communityV1.walletSeparateText':
    'This profile never receives your wallet address, balance, transactions, recovery words, or private keys.',
  'communityV1.localSearch': 'Search stays on this device',
  'communityV1.localSearchText':
    'Public entries are downloaded and searched here. Results and your activity stay on this device.',
  'communityV1.privacySettings': 'Community privacy',
  'communityV1.shareSearches': 'Help improve search suggestions',
  'communityV1.shareSearchesWelcomeText':
    'On by default. Submitted search terms may be shared without wallet data after private details are filtered. You can turn this off.',
  'communityV1.shareSearchesSettingsText':
    'Share submitted search terms without wallet data. Email addresses, wallet addresses, transaction IDs, phone numbers, and seed-like text are filtered first. Typed but unsubmitted text, results, and clicks are never shared.',
  'communityV1.shareSearchesSaveFailed':
    'This setting could not be saved. Its previous value remains active.',
  'communityV1.privateChat': 'Private one-to-one chat',
  'communityV1.privateChatText':
    'Messages are end-to-end encrypted. Only you and the other person can read them.',
  'communityV1.yourChoice': 'You are always in control',
  'communityV1.yourChoiceText':
    'Location is optional and approximate. You can hide, block, report, or delete your profile.',
  'communityV1.status': 'Private Community status',
  'communityV1.catalog': 'Local discovery',
  'communityV1.privateMessages': 'Private messages',
  'communityV1.ready': 'Ready',
  'communityV1.preparing': 'Not ready',
  'communityV1.notReady':
    'This secure Community version is still being prepared for this platform. Your wallet works normally.',
  'communityV1.safety':
    'Never share recovery words, private keys, or your wallet password with another person.',
  'communityV1.openFailed':
    'The private Community could not be opened. Please try again.',
  'communityV1.createProfile': 'Start private Community',
  'communityV1.openPrivateChat': 'Open private Community',
  'communityV1.publicProfile': 'Your public profile',
  'communityV1.publicProfileText':
    'Choose only a public name and a short description. Your wallet is never attached.',
  'communityV1.publicName': 'Public name',
  'communityV1.publicAbout': 'About you',
  'communityV1.reviewStatus': 'Review status',
  'communityV1.status.awaitingScreening': 'Waiting for automatic review',
  'communityV1.status.humanReview': 'Waiting for human review',
  'communityV1.status.needsChanges': 'Changes needed',
  'communityV1.status.quarantined': 'Held for safety review',
  'communityV1.status.approvedAwaitingEmbedding':
    'Approved · preparing local search',
  'communityV1.status.published': 'Published',
  'communityV1.status.hidden': 'Hidden',
  'communityV1.status.rejected': 'Not approved',
  'communityV1.status.removed': 'Removed',
  'communityV1.status.expired': 'Expired',
  'communityV1.status.withdrawn': 'Withdrawn',
  'communityV1.submitReview': 'Send for review',
  'communityV1.profileSubmitted': 'Your profile was sent for a safety review.',
  'communityV1.profileFailed': 'Your profile could not be saved.',
  'communityV1.productListing': 'Create a product listing',
  'communityV1.productListingText':
    'The listing is sent to the Community server for review. Your wallet details are never attached.',
  'communityV1.productTitle': 'Product title',
  'communityV1.productDescription': 'Description and important details',
  'communityV1.productCategories': 'Categories',
  'communityV1.productCategoriesHint':
    'Optional. Separate categories with commas, for example: books, privacy.',
  'communityV1.productCategoriesInvalid':
    'Each category must be no longer than 64 characters.',
  'communityV1.submitProduct': 'Send product for review',
  'communityV1.productSubmitted':
    'Your product listing is now stored on the server and waiting for review.',
  'communityV1.productFailed': 'The product listing could not be submitted.',
  'communityV1.discover': 'Find people and ideas',
  'communityV1.searchLabel': 'What are you looking for?',
  'communityV1.noResults': 'No matching public entries were found.',
  'communityV1.searchFailed': 'Search could not be completed on this device.',
  'communityV1.clearSearchHistory': 'Clear recent searches',
  'communityV1.searchHistoryCleared': 'Recent searches were cleared.',
  'communityV1.searchHistoryClearFailed':
    'Recent searches could not be cleared.',
  'communityV1.requestContact': 'Ask to connect',
  'communityV1.requestSent': 'Your private contact request was sent.',
  'communityV1.contactFailed': 'The contact request could not be updated.',
  'communityV1.contacts': 'Private contacts',
  'communityV1.contactRequest': 'Someone wants to connect',
  'communityV1.contactRequestText':
    'Accept only if you want this person to message you.',
  'communityV1.decline': 'Decline',
  'communityV1.accept': 'Accept',
  'communityV1.noContacts': 'You have no private contacts yet.',
  'communityV1.privateContact': 'Private contact',
  'communityV1.openChat': 'Open chat',
  'communityV1.privateConversation': 'Private conversation',
  'communityV1.chatSafety':
    'Messages are encrypted. Never send recovery words, private keys, or wallet passwords.',
  'communityV1.noMessages': 'No messages yet.',
  'communityV1.messagePlaceholder': 'Message',
  'communityV1.send': 'Send',
  'communityV1.sendFailed': 'The message could not be sent.',
  'communityV1.chatFailed': 'The private conversation could not be opened.',
  'communityV1.report': 'Report this message',
  'communityV1.reviewReport': 'Check the exact message',
  'communityV1.reviewReportText':
    'Only the message shown below and your reason will be sent for review.',
  'communityV1.reportReason': 'Why are you reporting this message?',
  'communityV1.confirmReport': 'Send report',
  'communityV1.reportSent': 'The selected message was reported.',
  'communityV1.reportFailed': 'The report could not be sent.',
  'communityV1.block': 'Block contact',
  'communityV1.blockConfirm':
    'This person will no longer be able to contact you. Continue?',
  'communityV1.blockFailed': 'This contact could not be blocked.',
  'communityV1.deleteProfile': 'Delete Community profile',
  'communityV1.deleteConfirm':
    'This permanently deletes your optional Community profile and private chats from this device. Your wallet is not changed.',
  'communityV1.deleteFailed':
    'The Community profile could not be deleted. Nothing was removed from this device.',
  'communityV1.suspended': 'Community profile paused',
  'communityV1.suspendedText':
    'You can read the moderation decision and appeal it. Your wallet continues to work normally.',
  'communityV1.reason': 'Reason',
  'communityV1.moderationDecision': 'Review decision',
  'communityV1.decisionPending': 'The review is still in progress.',
  'communityV1.appealReason': 'Why should this decision be reviewed again?',
  'communityV1.sendAppeal': 'Send free appeal',
  'communityV1.appealPending': 'Your appeal is waiting for review.',
  'communityV1.appealSent': 'Your appeal was sent.',
  'communityV1.appealFailed': 'Your appeal could not be sent.',
  'communityV1.enableNotifications': 'Enable Community updates',
  'communityV1.notificationsEnabled':
    'Community updates are enabled on this device.',
  'communityV1.notificationsFailed':
    'Notifications could not be enabled. You can continue without them.',
  'sync.error': 'Sync error',
  'sync.connectingNode': 'Connecting securely to the Monero node',
  'sync.selectingSource': 'Selecting sync source',
  'sync.startingConnection': 'Connecting to the selected sync node',
  'sync.startingConnectionHint':
    'Using the selected sync node. The app remains usable.',
  'sync.startingConnectionElapsed':
    '{seconds}s elapsed · Connecting directly to the selected sync node. The app remains usable.',
  'sync.showDetails': 'Show sync details',
  'sync.hideDetails': 'Hide sync details',
  'sync.downloadingBlocks': 'Downloading blocks',
  'sync.scanningWallets': 'Scanning all wallets',
  'sync.downloadingAndScanning': 'Downloading and scanning all wallets',
  'sync.checkingMempool': 'Checking pending transactions',
  'sync.savingWallets': 'Saving wallet state',
  'sync.retryingNode': 'Retrying node connection',
  'sync.failureNodeConfiguration':
    'Node settings are incomplete. Open Settings > Node.',
  'sync.failureNodeTimeout': 'The node did not respond in time. Trying again.',
  'sync.failureNodeUnreachable':
    'The node cannot be reached. Check your internet connection and node settings.',
  'sync.failureNodeSecurity':
    'The node security settings do not match. Check Settings > Node.',
  'sync.failureOptimizedService':
    'The Fast Wallet service is temporarily unavailable. Trying again.',
  'sync.failureServerResponse':
    'The sync server response could not be processed. Retrying safely with smaller batches.',
  'sync.failureServerResponseShort': 'Adjusting sync batch size',
  'sync.retryAttempt': 'Retry {count} in progress',
  'sync.failureWalletScan':
    'The wallet scan needs another attempt. Your funds remain safe.',
  'sync.degraded': 'Some wallets need another attempt',
  'sync.blockchainData': 'Blockchain data',
  'sync.connected': 'Connected',
  'sync.sharedPipeline': 'Shared wallet sync',
  'sync.walletsTogether': '{count} wallets use this block stream',
  'sync.checkingBlocks': 'Checking blocks',
  'sync.finalizing': 'Final verification',
  'sync.verifyingRecent': 'Verifying recent transactions',
  'sync.coreConfirming': 'Waiting for wallet confirmation',
  'sync.blockHeight': 'Block {current} of {target}',
  'sync.networkRate': '{rate} Mbit/s',
  'sync.derivationRate': '{rate} derivations/s',
  'sync.fullScanResult': 'Completed full scan',
  'sync.fullScanAverageNetwork': 'Average network: {rate} Mbit/s',
  'sync.fullScanAverageDerivations': 'Average scan: {rate} derivations/s',
  'sync.fullScanTotalTime': 'Total scan time: {duration}',
  'sync.fullScanEndToEnd': 'End-to-end throughput: {rate} Mbit/s',
  'sync.fullScanWaits':
    '{retries} retries · retry/offline {retry} · backpressure {backpressure}',
  'sync.blocksRemaining': '{count} blocks remaining',
  'sync.etaCalculating': 'Calculating time remaining',
  'sync.etaSeconds': 'About {count}s remaining',
  'sync.etaMinutes': 'About {count} min remaining',
  'sync.etaHours': 'About {count} h remaining',
  'sync.noWallet': 'No wallet',
  'sync.nodeOffline': 'Node offline',
  'sync.offline': 'Offline',
  'sync.opening': 'Opening',
  'sync.openWallet': 'Open wallet to sync',
  'sync.percent': '{percent}%',
  'sync.sendBalanceNotice': 'Balance can still change before sending.',
  'sync.synced': 'Synced',
  'sync.syncing': 'Scanning',
  'sync.scanningBlocks': 'Scanning blocks',
  'sync.updatingHistory': 'Updating history',
  'sync.waiting': 'Waiting',
  'sync.waitingForStatus': 'Preparing',
  'sync.ledgerSigningPreparationRequired': 'Ledger preparation required',
  'sync.ledgerSigningPreparationExplanation':
    'Blockchain and viewing wallet are synchronized. Nothing is running in the background. Connect and unlock your Ledger, open its Monero app, then start preparation.',
  'sync.prepareLedgerNow': 'Prepare Ledger now',
  'sync.wallet': 'Wallet sync',
  'sync.spendOutputs': 'Spend outputs',
  'sync.spendOutputsChecking': 'Checking spent outputs',
  'sync.spendOutputsNodeRetry': 'Retrying spent-output node check',
  'sync.waitingLedger':
    'Waiting for Ledger — unlock it and open the Monero app',
  'sync.connectingLedger': 'Connecting Ledger',
  'sync.persistingWallet': 'Saving verified wallet state',
  'sync.recoveringSession': 'Restoring wallet session',
  'sync.walletName': '{wallet}',
  'security.appProtection': 'Protect your wallet',
  'security.preparingProtection': 'Preparing secure app protection…',
  'security.biometricPrompt': 'Unlock Monero Fast Wallet',
  'security.biometricUnavailable':
    'Biometric unlock is not available on this device.',
  'security.enterPassword': 'Enter app password',
  'security.passwordIncorrect': 'The app password is incorrect.',
  'security.setUpAppProtectionHint':
    'Use one simple check to open all your wallets.',
  'security.useBiometrics': 'Use fingerprint instead',
  'security.biometricsRecommended': 'Recommended',
  'security.biometricsFallback': 'Your phone PIN works as a backup.',
  'security.useAppPassword': 'Use password instead',
  'security.passwordAlternative': 'Use a password you choose',
  'security.passwordRule':
    'Use at least 12 characters. A short sentence is easiest to remember.',
  'security.showPassword': 'Show password',
  'security.hidePassword': 'Hide password',
  'security.passwordRecoveryHelp':
    'Keep your recovery words safe. They can restore your wallets if you forget this password.',
  'security.passwordAttemptsRemaining':
    'Incorrect app password. Try again after the security delay.',
  'security.passwordAttemptRemaining':
    'Incorrect app password. Try again after the security delay.',
  'security.passwordResetInProgress':
    'App access is temporarily rate-limited. Wallet data remains safe.',
  'security.continueWithBiometrics': 'Use fingerprint',
  'security.unlockApp': 'Unlock app',
  'security.unlockAppHint': 'Unlock once to access all your saved wallets.',
  'security.unlockFailed': 'The app could not be unlocked.',
  'security.unlockWithBiometrics': 'Unlock with biometrics',
  'notification.incomingTitle': 'Incoming XMR',
  'notification.incomingAmount': '{amount} XMR incoming',
  'notification.incomingWallet': 'To {wallet}',
  'notification.outgoingTitle': 'XMR spent',
  'notification.outgoingAmount': '{amount} XMR spent',
  'notification.outgoingWallet': 'From {wallet}',
  'notification.closesIn': 'Closes in {seconds}s',
  'notification.ok': 'OK',
  'send.checkingSpendOutputs': 'Checking spent outputs with Ledger…',
  'ledgerSigning.connectTitle': 'Connect your Ledger',
  'ledgerSigning.connectedTitle': 'Ledger connected',
  'ledgerSigning.instructions':
    'Unlock the Ledger and open the Monero app. The wallet keeps looking until you cancel.',
  'ledgerSigning.searching': 'Looking for your Ledger…',
  'ledgerSigning.connecting': 'Connecting securely to Ledger…',
  'ledgerSigning.synchronizingInstructions':
    'Please be patient. The wallet checks new blocks and spendable coins with your Ledger before it can sign safely. Keep the Ledger unlocked with the Monero app open.',
  'ledgerSigning.synchronizingWallet':
    'Ledger connected. Synchronizing the signing wallet…',
  'ledgerSigning.connected': 'Ledger is connected.',
  'ledgerSigning.preparingRequest':
    'Preparing the transaction request for Ledger…',
  'ledgerSigning.awaitingConfirmation':
    'Request sent. Confirm the transaction on your Ledger.',
  'send.transactionBroadcastRefreshPending':
    'Transaction broadcast. Recheck Ledger spend outputs later in Settings.',
  'walletSelector.active': 'Active',
  'walletSelector.fast': '⚡ FAST',
  'walletSelector.ledgerFast': 'LEGACY LEDGER A1',
  'walletSelector.ledgerFastAccount':
    'Ledger account 1 · local only · not a Fast Wallet',
  'walletSelector.fastReady': 'Ready for payment alerts',
  'walletSelector.fastReceiveOnly': 'Fast Wallet can send after wallet sync.',
  'walletSelector.locked': 'Locked',
  'walletSelector.localOnly': 'Setting up',
  'walletSelector.nodeOffline': 'Node offline',
  'walletSelector.notSpendable': 'Open and sync before sending.',
  'walletSelector.openToLoad': 'Open to load balance',
  'walletSelector.openToCheckNode': 'Open to check node',
  'walletSelector.openToSend': 'Open and send',
  'walletSelector.preparing': 'Preparing',
  'walletSelector.ready': 'Ready',
  'walletSelector.ledgerBalanceNeedsVerification':
    'One-time Ledger check pending',
  'walletSelector.scanningWallet': 'Scanning wallet',
  'walletSelector.waitingSharedBlocks': 'Waiting for shared blocks',
  'walletSelector.pushOff': 'Push off',
  'walletSelector.pushReady': 'Active',
  'walletSelector.receiveTo': 'Receive to',
  'walletSelector.receiveOnly': 'Open and sync',
  'walletSelector.serverError': 'Action needed',
  'walletSelector.serverMismatch': 'Set up on this server',
  'walletSelector.sendFrom': 'Send from',
  'walletSelector.syncing': 'Sync',
  'walletSelector.synced': 'Synced',
  'walletSelector.tex8NodeRequired': 'Tex8 Node required',
  'walletSelector.wallets': 'Wallets',
  'fastWallet.status.actionNeeded': 'Action needed',
  'fastWallet.status.activeDescription':
    'The Fast Wallet server watches for incoming payments around the clock.',
  'fastWallet.status.activeNoPushDescription':
    'Automatic detection is active. Enable notifications to be alerted immediately.',
  'fastWallet.status.errorDescription':
    'The address works, but automatic detection is not active right now.',
  'fastWallet.status.nodeRequiredDescription':
    'The address works. Select Tex8 Node to enable automatic server detection.',
  'fastWallet.status.offDescription':
    'The address works, but automatic server detection is off.',
  'fastWallet.status.pushErrorDescription':
    'The address is active, but notifications could not be enabled.',
  'fastWallet.status.localOnly': 'Local only',
  'fastWallet.status.localOnlyDescription':
    'This receive address is ready. Connect it to the Fast Wallet server to enable automatic payment alerts.',
  'fastWallet.status.legacyBlocked': 'Security update required',
  'fastWallet.status.legacyBlockedDescription':
    'This legacy Fast Wallet is blocked because its seed can reveal the source wallet. Keep its files and use the guarded migration flow.',
  'fastWallet.status.paused': 'Fast paused',
  'fastWallet.status.serverChangedDescription':
    'Connect this Fast Wallet once to the selected Fast Wallet server.',
  'fastWallet.status.settingUp': 'Setting up',
  'fastWallet.status.settingUpDescription':
    'The app is connecting this address to the Fast Wallet server.',
  'welcome.subtitle': 'Private, fast, and in your control.',
  'welcome.savedWallets': 'Your wallets',
  'welcome.walletMode': 'Wallet mode',
  'welcome.chooseExperience': 'Choose your default',
  'welcome.chooseExperienceDescription':
    'You can change Fast Wallet for every private-wallet creation. This choice never enables server scanning, alerts, or sharing.',
  'welcome.privacyOnly': 'Privacy only',
  'welcome.privacyOnlyDescription':
    'Create only the private Monero wallet. Fast Wallet starts switched off.',
  'welcome.privacyComfort': 'Privacy + comfort',
  'welcome.privacyComfortDescription':
    'Fast Wallet starts switched on for each private-wallet creation. It is a separate local wallet with its own recovery words.',
  'setup.biometric.checking': 'Checking device security',
  'setup.biometric.secureDeviceKey': 'Secure device key',
  'setup.biometric.storedSecret':
    "A random local wallet password is generated and stored in this device's secure storage.",
  'setup.biometric.waiting': 'Waiting for device security status.',
  'setup.createDesc': 'Generate a new Monero wallet',
  'setup.existingWallets': 'Existing wallets',
  'setup.enthusiastsDescription':
    'Use an approximate area to discover people nearby, chat, and privately decide whether to meet.',
  'setup.enthusiastsTitle': 'Find Monero enthusiasts',
  'setup.fastWalletDescription':
    'Create a separate wallet for incoming-payment alerts. After backup, only this wallet is enrolled with the selected scanner.',
  'setup.fastWalletLedgerDescription':
    'Create a separate software Fast Wallet with its own recovery words. Ledger account 1 is not used.',
  'setup.fastWalletTitle': 'Create Fast Wallet',
  'setup.fastWalletToggle': 'Fast Wallet',
  'setup.fastWalletToggleDescription':
    'Also create a separate wallet with its own recovery words. After backup, its private view key is encrypted to the selected scanner for alerts.',
  'setup.fastWalletSlot': 'Fast Wallet slot',
  'setup.fastWalletSlotDescription':
    'Default 199. Choose 1–999. An occupied slot is never reused or uploaded.',
  'setup.fastWalletSlotRetiredDescription':
    'Next safe slot {slot}. Deleted wallet files are gone. Any slot used for hosted scanning stays blocked locally because earlier view access cannot be revoked.',
  'setup.fastWalletSlotInvalid':
    'Choose a whole Fast Wallet slot from 1 to 999.',
  'setup.fastWalletBackupRequired':
    'The separate Fast Wallet was created, but its recovery words still need to be backed up before you use its address.',
  'setup.fastWalletCreateFailed':
    'Your private wallet is ready. The optional Fast Wallet could not be created and can be added later from Wallets.',
  'setup.fastWalletPrimaryBackupFirst':
    'Back up the private wallet recovery words first. You can then create a Fast Wallet later from Wallets.',
  'setup.fastWalletTransferSending':
    'Sending encrypted view key to the Monero Fast Node scan service…',
  'setup.fastWalletTransferAccepted':
    'Monero Fast Node scan service accepted the encrypted view key.',
  'setup.fastWalletTransferFailed':
    'Monero Fast Node scan service did not accept the encrypted view key.',
  'setup.biometricFingerprint': 'Fingerprint',
  'setup.biometricFingerprintOrFace': 'Fingerprint or face unlock',
  'setup.biometricGeneric': 'Biometrics',
  'setup.createFastReceive': 'Creating Fast Wallet',
  'setup.device': 'Device',
  'setup.footer': 'Made with ❤️ by TEX8',
  'setup.footerAccessibility': 'Made with love by TEX8',
  'setup.hardware.connecting': 'Connecting Ledger',
  'setup.hardware.checkingHistory': 'Checking local wallet history',
  'setup.hardware.savingVerifiedBalance': 'Saving verified Ledger balance',
  'setup.hardware.syncingHistory': 'Scanning wallet history, block',
  'setup.hardware.syncingHistoryTitle': 'Wallet created — syncing history',
  'setup.hardware.verifyingOutputs': 'Verifying owned outputs with Ledger',
  'setup.hardware.verifyingTitle': 'Verifying Ledger wallet',
  'setup.hardware.bleFound': 'Ledger BLE found',
  'setup.hardware.desc': 'Create a hardware-backed Monero wallet',
  'setup.hardware.found': 'Ledger Nano found',
  'setup.hardware.instructions':
    'Connect Ledger Nano with Bluetooth or USB, unlock it, and open the Monero app on the device.',
  'setup.hardware.exportViewKeyTitle': 'Approve on your Ledger',
  'setup.hardware.exportViewKeyInstructions':
    'Keep Ledger Nano unlocked with the Monero app open. On the Ledger, approve Export view key. This window closes automatically when Ledger returns the private view key.',
  'setup.hardware.exportViewKeyWaiting': 'Waiting for Ledger…',
  'setup.hardware.localViewTitle': 'Remember Ledger for viewing',
  'setup.hardware.localViewDescription':
    'Keep an encrypted, read-only wallet on this device. You can view balances and receive without reconnecting Ledger; sending still requires Ledger.',
  'setup.hardware.fastWalletDescription':
    'Also create an independent software Fast Wallet with its own recovery words. It is not Ledger account 1.',
  'setup.hardware.localViewProtectionRequired':
    'Turn on app protection in Settings before saving Ledger viewing access on this device.',
  'setup.hardware.looking': 'Looking for an available Ledger transport.',
  'setup.hardware.openReady':
    'Ready to open with the connected hardware wallet.',
  'setup.hardware.permissionRequired': 'Permission required',
  'setup.hardware.searching': 'Searching...',
  'setup.hardware.searchingTitle': 'Searching for Ledger Nano',
  'setup.hardware.transportUnavailable': 'Ledger transport unavailable',
  'setup.hardware.waiting': 'Waiting for Ledger Nano',
  'setup.importDesc': 'Restore from Monero seed',
  'setup.importWallet': 'Import Wallet',
  'setup.importing': 'Importing Wallet',
  'setup.method.password': 'Password',
  'setup.opening': 'Opening Wallet',
  'setup.passwordConfirm': 'Confirm password',
  'setup.passwordMismatch': 'Passwords do not match.',
  'setup.prompt.createDeviceNoBiometric':
    'Create with a local secure device key. You will back up a 25-word seed.',
  'setup.prompt.createDeviceWithBiometric':
    'Use {biometric}. You will back up a 25-word seed.',
  'setup.prompt.createPassword':
    'Choose a local password. You will back up a 25-word seed.',
  'setup.prompt.openHardware':
    'Connect Ledger Nano, unlock it, and open the Monero app on the device.',
  'setup.prompt.openPassword': 'Enter the password for the local wallet file.',
  'setup.prompt.openStored':
    'Confirm {biometric} to unlock the local wallet file.',
  'setup.prompt.missingCredential':
    'This wallet is missing its protected device credential. Restore it from the recovery seed to create a new local copy.',
  'setup.prompt.restore':
    'Paste your 25-word Monero seed and choose a local password.',
  'setup.prompt.restoreStored':
    'Paste your 25-word Monero seed. This wallet will use your app security setting.',
  'setup.restoreHeight': 'Restore height (optional)',
  'setup.restoreHeightError': 'Restore height must be a number.',
  'setup.scanStart': 'Start syncing from date',
  'setup.scanAutomatic': 'Automatic (recommended)',
  'setup.scanRequired': 'Choose a date',
  'setup.scanDateHint':
    'Optional. The wallet starts slightly before this date so no payment on the selected date is missed.',
  'setup.ledgerScanDateHint':
    'Required for Ledger. Choose a date before its first transaction; choose today only for a brand-new Ledger wallet.',
  'setup.ledgerConnectBeforeOpen':
    'Connect a Ledger Nano before opening this wallet.',
  'setup.fastWalletSlotOccupied':
    'Fast Wallet slot {slot} cannot be reused. If its wallet was deleted, its local files are gone; the slot stays blocked because previously hosted read access cannot be taken back. Choose another slot.',
  'setup.fastWalletFileExists':
    'A local Fast Wallet file already exists for slot {slot}. Choose another slot or recover the existing wallet; nothing was overwritten.',
  'setup.fastWalletAppLocked':
    'The app locked before Fast Wallet creation finished. Unlock it and add the Fast Wallet from Wallets.',
  'setup.fastWalletNodeUnavailable':
    'The node height was not ready for safe Fast Wallet creation. Your private wallet is ready; reconnect and add the Fast Wallet from Wallets.',
  'setup.fastWalletStorageUnavailable':
    'Secure local storage could not finish Fast Wallet creation. Your private wallet is ready and no key was uploaded.',
  'setup.fastWalletCreationFailed':
    'Fast Wallet creation failed ({reason}). Your private wallet is ready and no key was uploaded. You can retry from Wallets.',
  'setup.scanDateError': 'Choose a valid date that is not in the future.',
  'setup.seedConfirm': 'I saved these 25 words offline.',
  'setup.seedFullError': 'Enter the full 25-word Monero seed.',
  'setup.seedPhrase': 'Seed phrase',
  'setup.seedSubtitle': 'Write down all 25 words before using the wallet.',
  'setup.seedSubtitleDynamic': 'Write down all {count} words exactly as shown.',
  'setup.seedTitle': 'Recovery Seed',
  'setup.step.derivingKeys': 'Deriving keys',
  'setup.step.encryptingSeed': 'Encrypting seed',
  'setup.step.generatingEntropy': 'Generating entropy',
  'setup.step.loadingWallet': 'Loading wallet',
  'setup.step.openingWallet': 'Opening wallet',
  'setup.step.openingMoneroApp': 'Opening Monero app',
  'setup.step.preparingBackup': 'Preparing backup',
  'setup.step.preparingScan': 'Preparing scan',
  'setup.step.preparingStorage': 'Preparing storage',
  'setup.step.preparingSync': 'Preparing sync',
  'setup.step.preparingWalletFile': 'Preparing wallet file',
  'setup.step.readingLocalState': 'Reading local state',
  'setup.step.readingPublicKeys': 'Reading public keys',
  'setup.step.restoringSeed': 'Restoring seed',
  'setup.step.savingWallet': 'Saving wallet',
  'setup.step.startingScan': 'Starting scan',
  'setup.step.waitingForLedger': 'Waiting for Ledger Nano',
  'setup.subtitle': 'Create, import, or connect Ledger Nano.',
  'setup.title': 'Wallet Setup',
  'home.all': 'All',
  'home.allWallets': 'All Wallets',
  'home.balance': 'My Balance',
  'home.chartLoading': 'Loading market chart…',
  'home.chartUnavailable': 'Market chart is temporarily unavailable.',
  'home.priceUnavailable': 'XMR market price is temporarily unavailable.',
  'home.updatesTitle': 'Official Monero updates',
  'home.updatesSource': 'MONERO PROJECT · GITHUB',
  'home.updatesSourceLink': 'View source',
  'home.updatesLoading': 'Loading official updates…',
  'home.updatesUnavailable': 'Official updates are unavailable right now.',
  'home.newsTitle': 'Monero news',
  'home.newsSource': 'TEX8 · LIVE NEWS',
  'home.newsSourceLink': 'All news',
  'home.newsLoading': 'Loading the latest Monero news…',
  'home.newsUnavailable': 'News are unavailable right now.',
  'home.newsEmpty': 'No news in this category yet.',
  'home.newsAll': 'All',
  'home.newsNetwork': 'Network',
  'home.newsWallet': 'Wallet',
  'home.newsEcosystem': 'Ecosystem',
  'home.newsReadMore': 'Read article',
  'advertising.advertisement': 'Advertisement',
  'advertising.sponsored': 'Sponsored',
  'advertising.paidBy': 'Paid by {advertiser}',
  'advertising.learnMore': 'Learn more',
  'advertising.why': 'Why am I seeing this?',
  'advertising.reasonContextual':
    'Selected on this device for this placement. No viewing history or wallet data was sent to the server.',
  'advertising.reasonLocal':
    'Ranked on this device using your private local interests. Your interest profile and viewing history never leave this device.',
  'home.createOrImport': 'Create or Import',
  'home.loadingBalance': 'Loading balance',
  'home.lockedBalance': 'Locked: {amount} XMR',
  'home.noTransactions': 'No transactions yet',
  'home.noTransactionsText':
    'Activity appears here after the wallet has scanned matching outputs.',
  'home.fastWalletTransactionsTitle': 'Fast Wallet monitoring active',
  'home.fastWalletTransactionsText':
    'Incoming payments are monitored by the Fast Wallet server. This wallet does not need to be open locally.',
  'home.noWallet': 'No wallet',
  'home.openWalletToLoad': 'Open or create a wallet to load private activity.',
  'home.pending': '{amount} XMR pending',
  'home.received': 'Received',
  'home.sent': 'Sent',
  'home.timeframeMax': 'Max',
  'home.timeframeToday': 'Today',
  'home.totalBalance': 'Total Balance',
  'home.marketPrice': 'Monero market price',
  'home.ledgerBalanceNeedsVerification':
    'One-time initial Ledger verification is still pending. Unlock Ledger and open its Monero app; this app completes the check automatically.',
  'home.ledgerBalanceVerificationHint':
    'Connect and unlock the Ledger, open its Monero app, then verify which outputs are available to spend.',
  'home.verifyLedgerBalance': 'Verify with Ledger',
  'home.verifyingLedgerBalance': 'Waiting for Ledger…',
  'home.ledgerReconciliation.connecting-ledger': 'Finding Ledger…',
  'home.ledgerReconciliation.checking-local-scan':
    'Checking local wallet scan…',
  'home.ledgerReconciliation.catching-up-local-scan':
    'Scanning locally before Ledger verification…',
  'home.ledgerReconciliation.deriving-owned-output-key-images':
    'Verifying owned outputs with Ledger…',
  'home.ledgerReconciliation.saving-ledger-balance': 'Saving verified balance…',
  'home.ledgerWalletCouldNotOpen':
    'The local Ledger companion could not be opened.',
  'home.transactions': 'Transactions',
  'home.walletLocked': 'Wallet Locked',
  'home.walletNotOpen': 'Wallet not open',
  'send.addressBook': 'Address book',
  'send.addressBookHint': 'Choose a saved address or add one for next time.',
  'send.addContact': 'Add address',
  'send.amount': 'Amount',
  'send.all': 'All',
  'send.amountAboveBalance': 'Amount is above unlocked balance.',
  'send.available': 'Available',
  'send.confirmDetails': 'Confirm the private transfer details.',
  'send.contacts': 'Contacts',
  'send.contactDetailsRequired': 'Enter a name and a Monero address.',
  'send.contactName': 'Name',
  'send.enterValidAmount': 'Enter a valid XMR amount.',
  'send.feePrepared': 'Fee prepared. Review once more, then send.',
  'send.feePreparedBeforeBroadcast': 'Fee prepared before broadcast',
  'send.fee': 'Fee',
  'send.networkFee': 'Network fee',
  'send.priority': 'Fee priority',
  'send.priorityHigh': 'High',
  'send.priorityLow': 'Low',
  'send.priorityMedium': 'Medium',
  'send.priorityNormal': 'Normal',
  'send.noRecent': 'No recent transfers',
  'send.noRecentText':
    'Synced wallet activity appears here after the wallet is opened.',
  'send.noSavedContacts':
    'No saved addresses yet. Add one below or paste an address instead.',
  'send.noRecipient': 'No recipient selected',
  'send.invalidRecipientForNetwork':
    'This address is not valid for the selected Monero network.',
  'send.mfwUnavailable':
    'This wallet name cannot be checked safely right now. Ask for the Monero address or QR code.',
  'send.openWalletBeforePreparing':
    'Open or create a wallet before preparing a transfer.',
  'send.openWalletBeforeSending': 'Open or create a wallet before sending.',
  'send.pasteAddress': 'Paste Monero address',
  'send.resolvingMfwName': 'Looking up wallet name…',
  'send.resolvedMfwAddress': 'Resolved Monero address',
  'send.useMfwSuggestion': 'Use {name}',
  'send.manualRecipient': 'Enter address manually',
  'send.manualRecipientHint': 'Paste an address or choose a saved contact.',
  'send.or': 'or',
  'send.scanAddress': 'Scan QR code',
  'send.scanAddressHint': 'Point your camera at the recipient QR code.',
  'send.scanCameraDenied':
    'Camera access is needed to scan a Monero receiving address.',
  'send.scanCameraUnavailable':
    'This device does not have an available camera. Paste the address instead.',
  'send.scanFailed': 'The camera could not start. Paste the address instead.',
  'send.scanHint': 'Point the camera at a Monero receiving-address QR code.',
  'send.scanInvalid': 'This QR code does not contain a Monero address.',
  'send.saveContact': 'Save address',
  'send.openSettings': 'Open settings',
  'send.privacy': 'Privacy',
  'send.privacyDetails': 'Sender, recipient, and amount stay hidden on-chain.',
  'send.privateTransfer': 'Private transfer',
  'send.preparedNext': 'Prepared next',
  'send.recentTransactions': 'Recent Transactions',
  'send.recentContacts': 'Recent contacts',
  'send.recipient': 'Recipient',
  'send.recipientHidden': 'Recipient hidden',
  'send.reviewPayment': 'Review Payment',
  'send.sendXmr': 'Send XMR',
  'send.stealthAddress': 'Stealth address',
  'send.subtitle': 'Paste a Monero address and review before sending.',
  'send.sweepAll':
    'The native wallet calculates the exact maximum after the network fee.',
  'send.title': 'Send XMR',
  'send.total': 'Total',
  'send.transactionBroadcast': 'Transaction broadcast.',
  'send.transactionBroadcastFailed': 'Transaction broadcast failed',
  'send.transactionPreparationFailed': 'Transaction preparation failed',
  'send.successTitle': 'Transaction sent',
  'send.successSubtitle':
    'Your transaction was signed and broadcast to the Monero network.',
  'send.successRefreshing': 'Updating balance and transaction history…',
  'send.successReady': 'Balance and transaction history updated.',
  'send.successDone': 'Done',
  'send.waitForSync': 'Wait until this wallet is synced before sending.',
  'send.viewMore': 'View more',
  'send.checkRecipientTitle': 'Check the recipient',
  'send.checkRecipientDescription':
    'Compare the name and full address before entering an amount.',
  'send.checkRecipientHint':
    'The address was checked for the selected Monero network. Nothing will be sent yet.',
  'send.useThisRecipient': 'Use this recipient',
  'send.confirmChangedAddress': 'I recognize the new address',
  'send.fullAddress': 'Full address',
  'send.addressFingerprint': 'Short address check',
  'send.resolutionSource': 'Found through',
  'send.sharingFreshness': 'Shared contact status',
  'send.sharedUntil': 'Current until {date}',
  'send.addressChangedWarning':
    'This person now shares a different receive address than the one you accepted before. Check with them before continuing.',
  'send.privateContactWrongNetwork':
    'This private contact address is for a different Monero network.',
  'send.privateContactUnavailable':
    'This private contact address is no longer available. Check the person again.',
  'send.sourceManual': 'Address entered manually',
  'send.sourceQr': 'Scanned QR code',
  'send.sourceAddressBook': 'Saved address book',
  'send.sourceMfwName': 'Public .mfw name',
  'send.sourcePaymentLink': 'Verified payment link',
  'send.sourcePrivateContact': 'Private phone contact',
  'send.paymentLinkErrorTitle': 'Payment link unavailable',
  'send.paymentLinkInvalid':
    'This payment link is invalid or expired. Ask for a new link.',
  'send.paymentLinkUnavailable':
    'This payment link could not be loaded securely. Try again later.',
  'transactions.account': 'Account',
  'transactions.amount': 'Amount',
  'transactions.blockHeight': 'Block height',
  'transactions.confirmations': 'Confirmations',
  'transactions.confirmationsShort': '{count} conf.',
  'transactions.confirmed': 'Confirmed',
  'transactions.copyId': 'Copy transaction ID',
  'transactions.date': 'Date',
  'transactions.description': 'Description',
  'transactions.details': 'Transaction Details',
  'transactions.direction': 'Direction',
  'transactions.fee': 'Network fee',
  'transactions.hiddenAddress': 'Address hidden by Monero',
  'transactions.label': 'Label',
  'transactions.miningReward': 'Mining reward',
  'transactions.notFound': 'Transaction not found.',
  'transactions.openDetails': 'Open transaction details',
  'transactions.openWalletToLoad':
    'Open this wallet to load its transaction history.',
  'transactions.paymentId': 'Payment ID',
  'transactions.selfTransfer': 'Self transfer',
  'transactions.status': 'Status',
  'transactions.subaddresses': 'Subaddresses',
  'transactions.title': 'All Transactions',
  'transactions.transactionId': 'Transaction ID',
  'transactions.transfer': 'Transfer',
  'transactions.transferNumber': 'Transfer {count}',
  'transactions.transfers': 'Transfer details',
  'transactions.type': 'Type',
  'transactions.unlockTime': 'Unlock time',
  'transactions.viewMore': 'View more',
  'transactions.loadMore': 'Load more',
  'transactions.wallet': 'Wallet',
  'receive.addressLabel': 'YOUR MONERO ADDRESS',
  'receive.addresses': 'Addresses',
  'receive.amountOptional': 'Amount (optional)',
  'receive.checkDevice': 'Check device',
  'receive.connected': 'Connected',
  'receive.emptyText':
    'Open or create a wallet to show your receiving address.',
  'receive.backupFastWalletFirst': 'Back up this Fast Wallet first',
  'receive.backupFastWalletText':
    'Its receive address stays hidden until you confirm that the recovery words are safely backed up.',
  'receive.backupNow': 'Back up now',
  'receive.hardwareAddressConfirmed': 'Address confirmed on the Ledger Nano.',
  'receive.hardwareConfirmAddress':
    'Confirm the address request on the Ledger Nano.',
  'receive.hardwareConnected': 'Ledger Nano is connected.',
  'receive.hardwareConnectUnlock':
    'Connect and unlock the Ledger Nano, then open the Monero app.',
  'receive.hardwareNotChecked': 'Ledger status has not been checked yet.',
  'receive.ledgerFastWallet': 'Ledger Fast Wallet',
  'receive.newAddress': 'New address',
  'receive.newAddressLabel': 'Address {count}',
  'receive.newAddressName': 'Address label',
  'receive.newAddressPlaceholder': 'For example: Savings or Invoice',
  'receive.subaddressPrivacyHint':
    'Each address belongs to this wallet and is recovered by the same recovery words.',
  'receive.manageAddresses': 'Manage receiving addresses',
  'receive.otherAddresses': 'Other receiving addresses',
  'receive.paymentLink': 'Monero payment link',
  'receive.copyPaymentLink': 'Copy link',
  'receive.paymentLinkCopied': 'Link copied',
  'receive.paymentLinkError':
    'The secure payment link could not be created. Check Tor and try again.',
  'receive.sharePaymentLink': 'Share payment link',
  'receive.privacyText':
    'Every transaction is automatically private. Sender, recipient, and amount are never visible.',
  'receive.primaryAddress': 'Primary address',
  'receive.privacyTitle': 'Privacy by Default',
  'receive.stealthText':
    'You can reuse the same address multiple times. Monero automatically generates one-time stealth addresses.',
  'receive.stealthTitle': 'Stealth Addresses',
  'receive.subtitle': 'Share your address to receive XMR',
  'receive.title': 'Receive',
  'receive.usdRateUnavailable': 'The XMR/USD rate is currently unavailable.',
  'receive.walletLocked': 'Wallet Locked',
  'receive.noWalletOpen': 'No Wallet Open',
  'enthusiasts.disabledText':
    'Turn discovery on when you want to meet and talk with people nearby.',
  'enthusiasts.disabledTitle': 'Discovery is off',
  'enthusiasts.emptyText':
    'People who share the same approximate area will appear here without revealing an exact position.',
  'enthusiasts.emptyTitle': 'No one nearby yet',
  'enthusiasts.locationRetry': 'Allow approximate location',
  'enthusiasts.debugGps': 'DEBUG · GPS',
  'enthusiasts.debugLocalOnly':
    'Shown only on this device for testing. Exact coordinates are neither saved nor shared.',
  'enthusiasts.myListing': 'MY LISTING',
  'enthusiasts.listingVisible': 'Visible within {radius} km',
  'enthusiasts.removeListing': 'Remove listing',
  'enthusiasts.removeListingTitle': 'Remove your listing?',
  'enthusiasts.removeListingDescription':
    'You will no longer appear nearby. Your anonymous account and contacts stay available.',
  'enthusiasts.menuDescription': 'Talk and meet privately nearby',
  'enthusiasts.nearby': 'Nearby',
  'enthusiasts.privacy':
    'Only a broad area is used. Your exact position, wallet addresses, balances, and transactions are never part of discovery.',
  'enthusiasts.radius': 'SEARCH AREA',
  'enthusiasts.status.denied': 'Location permission is off',
  'enthusiasts.status.error': 'Location could not be updated',
  'enthusiasts.status.not_requested': 'Approximate location is not ready',
  'enthusiasts.status.off': 'Not visible to others',
  'enthusiasts.status.ready': 'Visible within an approximate area',
  'enthusiasts.status.requesting': 'Finding your approximate area',
  'enthusiasts.status.unavailable': 'Location is currently unavailable',
  'enthusiasts.subtitle':
    'Discover people nearby without sharing an exact location.',
  'enthusiasts.title': 'Monero Enthusiasts',
  'enthusiasts.visibility': 'Visible nearby',
  'enthusiasts.accept': 'Accept',
  'enthusiasts.acceptedContact': 'Accepted contact',
  'enthusiasts.block': 'Block',
  'enthusiasts.chat': 'Chat',
  'enthusiasts.chatEmpty': 'Say hello when you are ready.',
  'enthusiasts.connect': 'Connect',
  'enthusiasts.connections': 'Connections',
  'enthusiasts.deleteAction': 'Delete community profile',
  'enthusiasts.deleteDescription':
    'Your anonymous profile, contacts, and messages will be removed from the community server.',
  'enthusiasts.deleteTitle': 'Delete community profile?',
  'enthusiasts.contact.connected': 'Accepted contact',
  'enthusiasts.contact.incoming': 'Wants to connect',
  'enthusiasts.contact.outgoing': 'Request sent',
  'enthusiasts.distance': 'About {distance} km away',
  'enthusiasts.messagePlaceholder': 'Message',
  'enthusiasts.namePlaceholder': 'Your public alias',
  'enthusiasts.noConnections': 'No accepted contacts yet.',
  'enthusiasts.report': 'Report',
  'enthusiasts.requested': 'Requested',
  'enthusiasts.safety': 'Safety',
  'enthusiasts.serverError':
    'Community is temporarily unavailable. Check your connection, then try again.',
  'enthusiasts.yourName': 'YOUR PUBLIC ALIAS',
  'mfwNames.activationPending':
    'Name registration is not active in this release yet. The signed Monero Fast Wallet Registry address and protocol genesis parameters must be frozen first.',
  'mfwNames.address': 'Receive address',
  'mfwNames.addressLoadFailed': 'Wallet addresses could not be loaded.',
  'mfwNames.chooseWalletAddress': 'Choose from wallet',
  'mfwNames.enterAddressManually': 'Enter manually',
  'mfwNames.manualAddress': 'Manual Monero address',
  'mfwNames.manualAddressPlaceholder': 'Paste or type any Monero address',
  'mfwNames.invalidAddress': 'Enter a valid Monero address for this network.',
  'mfwNames.availabilityAvailable':
    'Available at the current verified chain tip.',
  'mfwNames.availabilityAvailableAgain':
    'Available for a new claim because the previous record is no longer active.',
  'mfwNames.availabilityChecking':
    'Checking availability with the public resolver…',
  'mfwNames.availabilityPending':
    'This name currently has a provisional registration.',
  'mfwNames.availabilityRequired':
    'A current, verified availability result is required.',
  'mfwNames.availabilityReserved':
    'This protocol-reserved name cannot be registered.',
  'mfwNames.availabilityTaken': 'This name is already registered.',
  'mfwNames.availabilityUnavailable':
    'Availability cannot be verified safely right now. Registration remains blocked.',
  'mfwNames.checkedAt': 'Checked at',
  'mfwNames.checkedChainTip': 'Checked chain tip',
  'mfwNames.estimatedExpiredAt': 'Estimated expired around',
  'mfwNames.estimatedValidUntil': 'Estimated valid until',
  'mfwNames.cancelRenewal': 'Cancel',
  'mfwNames.chooseAddress': 'Choose a receive address for this name.',
  'mfwNames.claimYourAddress': 'Claim your address',
  'mfwNames.ticker': 'Secure your .mfw name now',
  'mfwNames.customTerm': 'Other duration',
  'mfwNames.termRange': 'Enter a whole number from 1 to {max} years.',
  'mfwNames.claimText':
    'With the TEX8 relay and separate spendable funds, approve the second transaction next. The relay learns the claim early and sends it after 15 blocks. Otherwise, return for step 2 when notified.',
  'mfwNames.claimTitle': 'Claim and pay',
  'mfwNames.claimBroadcastMessage':
    'Step 2 of 2 was sent. The name becomes active after blockchain confirmation.',
  'mfwNames.claimPendingBanner':
    'The final transaction was sent. Waiting for blockchain confirmation.',
  'mfwNames.claimReadyBanner':
    'Approve the final transaction now. About {blocks} blocks remain in the claim window.',
  'mfwNames.claimDeadlineHeight': 'Claim deadline: block {height}',
  'mfwNames.commitText':
    'Review a prefilled commitment transaction. It hides the name from mempool observers.',
  'mfwNames.commitTitle': 'Commit the name',
  'mfwNames.commitBlocksBanner':
    'Step 2 becomes available in about {blocks} block(s). We will remind you locally.',
  'mfwNames.commitBroadcastMessage':
    'Step 1 of 2 was sent. Step 2 becomes available after 15 blocks; the app will remind you.',
  'mfwNames.commitWaitingBanner':
    'Waiting for the commit to be mined. Step 2 normally follows after about 30 minutes.',
  'mfwNames.availabilityLocalPending':
    'Step 1 is already pending on this device. Complete step 2 instead of registering again.',
  'mfwNames.localRegistrationPending':
    'This registration is already in progress. Continue with its next step.',
  'mfwNames.maturityHeight': 'Step 2 available from block {height}',
  'mfwNames.confirmClaim': 'Confirm claim',
  'mfwNames.confirmCommit': 'Confirm commit',
  'mfwNames.approvalExpiresIn': 'Transaction approval expires in {seconds}s.',
  'mfwNames.approvalExpired':
    'Transaction approval expired. Prepare it again before confirming.',
  'mfwNames.prepareApprovalAgain': 'Prepare approval again',
  'mfwNames.confirmRenew': 'Confirm renewal',
  'mfwNames.confirmRevoke': 'Confirm revocation',
  'mfwNames.confirmUpdate': 'Confirm address change',
  'mfwNames.continue': 'Prepare first approval',
  'mfwNames.createDedicated': 'Create a dedicated address',
  'mfwNames.createDedicatedHint':
    'Recommended: avoid permanently linking the public name to your primary address.',
  'mfwNames.currentAddress': 'Current public address',
  'mfwNames.dedicated': 'Dedicated',
  'mfwNames.decryptRecovery': 'Open native recovery prompt',
  'mfwNames.daysRemaining': 'Days left',
  'mfwNames.daysValue': '~{count} days',
  'mfwNames.expiredFreshClaim':
    'This name is no longer active and must be registered again with a new commit and claim.',
  'mfwNames.expiresAtBlock': 'Expiry block',
  'mfwNames.expiryEstimate':
    'Times and days are estimates at the two-minute block target; the expiry block is authoritative.',
  'mfwNames.invalidName':
    'Use 1–63 lowercase letters, numbers or internal hyphens.',
  'mfwNames.registeredNames': 'Already registered names',
  'mfwNames.registeredNamesSubtitle':
    'Names you have already registered on this device.',
  'mfwNames.myNames': 'Your names',
  'mfwNames.showMore': 'Show more',
  'mfwNames.showLess': 'Show less',
  'mfwNames.newAddress': 'New public address',
  'mfwNames.name': 'Address name',
  'mfwNames.nameHint':
    'The .mfw suffix is added automatically. Unicode lookalikes are not allowed.',
  'mfwNames.namePlaceholder': 'alice',
  'mfwNames.namesLoadFailed': 'Your locally tracked names could not be loaded.',
  'mfwNames.nativePreparationRequired':
    'Native name transaction preparation is not enabled in this build.',
  'mfwNames.networkFeesExtra': 'Two normal Monero network fees are additional',
  'mfwNames.noAddress': 'Open this wallet once to load its addresses.',
  'mfwNames.noNames': 'No locally tracked .mfw names yet.',
  'mfwNames.noWallet': 'No wallet selected',
  'mfwNames.oneRenewalApproval': 'One explicit approval is required',
  'mfwNames.openSelectedWallet':
    'Open the selected wallet before creating a dedicated address.',
  'mfwNames.openWalletFirst': 'Open and sync a wallet first.',
  'mfwNames.ownerKeySecurity':
    'A separate name-owner key is kept in device-protected native storage. Its encrypted recovery backup is required before registration.',
  'mfwNames.primaryAddress': 'Primary address',
  'mfwNames.prepareRenewal': 'Prepare renewal',
  'mfwNames.prepareUpdate': 'Prepare address change',
  'mfwNames.operation': 'Protocol action',
  'mfwNames.publicWarning':
    'The name and receive address remain publicly visible in Monero blockchain history. The public address cannot spend funds or reveal your wallet balance.',
  'mfwNames.registryPrice': 'Monero Fast Wallet Registry price',
  'mfwNames.recoveryRequired':
    'Save the encrypted owner recovery before approving the registration.',
  'mfwNames.recoveryImported':
    'Owner recovery restored. This device can now manage the active name.',
  'mfwNames.recoveryNativePrompt':
    'The encrypted bundle and password stay inside the protected native screen.',
  'mfwNames.registerAgain': 'Register again',
  'mfwNames.removeExpiredTitle': 'Delete expired entry?',
  'mfwNames.removeExpiredDescription':
    'This removes only the expired entry from this device. It does not change the blockchain.',
  'mfwNames.removeExpiredFailed': 'The expired entry could not be deleted.',
  'mfwNames.registeredTerm': 'Term',
  'mfwNames.renew': 'Renew',
  'mfwNames.renewDescription':
    'Choose the additional term. Renewal retains the existing public address and must be signed by the protected name-owner key.',
  'mfwNames.renewNetworkFeeExtra':
    'One normal Monero network fee is additional',
  'mfwNames.renewTitle': 'Renew name',
  'mfwNames.renewTransactionText':
    'Review one prefilled owner-signed transaction that extends this active record.',
  'mfwNames.reviewSubtitle':
    'The Monero Fast Wallet Registry destination, amount and signed protocol data are locked by the native wallet. Check them, then approve.',
  'mfwNames.reviewTitle': 'Review name transaction',
  'mfwNames.restoreRecovery': 'Restore owner recovery',
  'mfwNames.restoreRecoveryDescription':
    'Enter the public name first. The wallet verifies its current blockchain record before the native recovery screen decrypts anything.',
  'mfwNames.revoke': 'Revoke',
  'mfwNames.revokeTitle': 'Revoke name',
  'mfwNames.selectedWallet': 'Selected wallet: {wallet}',
  'mfwNames.subaddressLabel': '{name} public name',
  'mfwNames.subtitle':
    'Claim a memorable public .mfw name for one of your Monero receive addresses.',
  'mfwNames.statusActive': 'Active',
  'mfwNames.statusClaimPending': 'Claim pending',
  'mfwNames.statusCommitPending': 'Commit pending',
  'mfwNames.statusExpired': 'Expired',
  'mfwNames.statusFailed': 'Failed',
  'mfwNames.statusRenewPending': 'Renewal pending',
  'mfwNames.statusRevokePending': 'Revocation pending',
  'mfwNames.statusUpdatePending': 'Address change pending',
  'mfwNames.statusRevealReady': 'Ready to claim',
  'mfwNames.statusClaimExpired': 'Claim window expired',
  'mfwNames.claimExpiredDescription':
    'Step 2 was not broadcast within the claim window. Start the registration again with a new commit.',
  'mfwNames.statusRevoked': 'Revoked',
  'mfwNames.stepOneComplete': 'Step 1 of 2 completed',
  'mfwNames.stepOneSentDescription':
    'The private commitment was sent to the blockchain.',
  'mfwNames.stepTwoReady': 'Step 2 of 2 is ready',
  'mfwNames.stepTwoReadyDescription':
    'Approve the claim and registry payment now. About {blocks} blocks remain.',
  'mfwNames.stepTwoSent': 'Step 2 of 2 sent',
  'mfwNames.stepTwoSentDescription':
    'The claim and registry payment are waiting for blockchain confirmation.',
  'mfwNames.stepTwoScheduled': 'Both approvals completed',
  'mfwNames.relayUploading': 'Both transactions signed. Connecting to the delivery service — keep the app open until the server confirms receipt.',
  'mfwNames.relayAccepted': 'The server has saved step 2 and will send it after 15 blocks, even with the app closed. Notification requires notifications to be enabled.',
  'mfwNames.relayCheckStatus': 'Both transactions signed. Check the delivery status above before closing the app.',
  'mfwNames.relayTransmitting': 'The server is delivering step 2. Waiting for the transaction to appear on the network.',
  'mfwNames.relayCancel': 'Stop automatic delivery · complete step 2 manually',
  'mfwNames.relayCancelling': 'Waiting for cancellation confirmation…',
  'mfwNames.relayApproveSecond': 'Step 2 of 2: approve the claim and payment now. It will be handed to the server for delayed delivery.',
  'mfwNames.relayManualFallback': 'Automatic step 2 was unavailable. Confirm it here once the commit is ready. Enable notifications for a reminder; a reminder is not a confirmation of blockchain maturity.',
  'mfwNames.stepTwoScheduledDescription':
    'The final transaction is protected on this device and will be sent automatically after 15 blocks.',
  'mfwNames.notificationTitle': 'Monero Fast Wallet name',
  'mfwNames.notificationCheckStepTwo':
    'Open the app to check whether step 2 of 2 is ready.',
  'mfwNames.notificationStepTwoReady':
    'Step 2 of 2 is ready. Open the app to complete your name registration.',
  'mfwNames.term': 'Registration term',
  'mfwNames.termValue': '{count} protocol year(s)',
  'mfwNames.title': 'Your Address Names',
  'mfwNames.twoApprovals': 'Two explicit approvals are required',
  'mfwNames.changeAddress': 'Change address',
  'mfwNames.chooseDifferentAddress':
    'Choose an address that differs from the current public address.',
  'mfwNames.chooseNewAddress': 'Choose the new public receive address.',
  'mfwNames.oneUpdateApproval': 'One explicit approval is required',
  'mfwNames.updateDescription':
    'Choose the new public receive address. The protected name-owner key signs the change.',
  'mfwNames.updateNetworkCost':
    'No Monero Fast Wallet Registry fee for an address change',
  'mfwNames.updateTitle': 'Change public address',
  'mfwNames.updateTransactionText':
    'Review one prefilled owner-signed transaction that replaces the public receive address.',
  'mfwNames.unknownWallet': 'Unknown wallet',
  'mfwNames.wallet': 'Wallet for this name',
  'mfwNames.walletNoLongerAvailable':
    'This name’s wallet or current canonical status is not available. Open and sync the original wallet before continuing.',
  'mfwNames.year': 'year',
  'mfwNames.years': 'years',
  'privateContacts.title': 'Private contacts',
  'privateContacts.menuDescription':
    'Find people or privately share a receive address',
  'privateContacts.subtitle':
    'Your contacts stay on this device. You choose who can see what.',
  'privateContacts.findTitle': 'Find people from my contacts',
  'privateContacts.findDescription':
    'The app checks protected anonymous codes on this device. Names and phone numbers are not uploaded.',
  'privateContacts.findOn': 'Finding people is on',
  'privateContacts.findOff': 'Turn on finding people',
  'privateContacts.turnOff': 'Turn off',
  'privateContacts.verifyTitle': 'Verify your phone number',
  'privateContacts.verifyDescription':
    'This only proves that you can receive a code at this number. It does not verify your identity.',
  'privateContacts.phonePlaceholder': 'International number, for example +507…',
  'privateContacts.sendCode': 'Send code',
  'privateContacts.codePlaceholder': 'Verification code',
  'privateContacts.confirmCode': 'Confirm code',
  'privateContacts.verifiedUntil': 'Phone verified until {date}',
  'privateContacts.shareTitle': 'Share with selected contacts',
  'privateContacts.shareDescription':
    'Nothing is shared automatically. Pick one person and one simple option.',
  'privateContacts.manualName': 'Name (only saved on this device)',
  'privateContacts.noContacts':
    'Turn on contact access above, or enter one phone number manually.',
  'privateContacts.badge': 'Show that I use Fast Wallet',
  'privateContacts.badgeDescription': 'No receive address is shared.',
  'privateContacts.ask': 'Ask me before sharing',
  'privateContacts.askDescription':
    'The other person must request a receive address each time.',
  'privateContacts.direct': 'Share a receive address',
  'privateContacts.directDescription':
    'Creates a separate public receive address in your open wallet. No private key is shared.',
  'privateContacts.stopSharing': 'Stop sharing',
  'privateContacts.statusPublishing': 'Saving securely…',
  'privateContacts.statusActive': 'Shared',
  'privateContacts.statusRevoking': 'Removing…',
  'privateContacts.walletRequired':
    'Open the wallet you want to use before sharing an address.',
  'privateContacts.removeTitle': 'Remove my phone number',
  'privateContacts.removeDescription':
    'Stops all contact sharing and removes this phone from the private directory.',
  'privateContacts.removeAction': 'Remove my phone',
  'privateContacts.useTitle': 'Pay this person',
  'privateContacts.useDescription':
    'Check privately whether this person shared a current receive address with you.',
  'privateContacts.checkPerson': 'Check this person',
  'privateContacts.lookupBadge':
    'This person uses Fast Wallet, but has not shared a receive address.',
  'privateContacts.lookupAsk':
    'This person wants to approve each address request. No address has been shared yet.',
  'privateContacts.requestAddress': 'Ask for an address',
  'privateContacts.outgoingTitle': 'Address request',
  'privateContacts.requestSent':
    'Your private request was sent. You can leave this page and check again later.',
  'privateContacts.requestAnswered': 'The person has answered your request.',
  'privateContacts.checkRequest': 'Check answer',
  'privateContacts.requestStillWaiting': 'Still waiting for an answer.',
  'privateContacts.requestDeclined':
    'The person chose not to share an address.',
  'privateContacts.requestExpired':
    'This request expired. You can send a new one.',
  'privateContacts.incomingTitle': 'Someone is asking for an address',
  'privateContacts.incomingDescription':
    'Only share if you know the person. A new receive address is created for every approval.',
  'privateContacts.requestExpires': 'Answer before {time}',
  'privateContacts.declineRequest': 'Do not share',
  'privateContacts.approveRequest': 'Share new address',
  'privateContacts.approveRequestConfirm':
    'Share a new receive address with this person? They cannot spend your money.',
  'privateContacts.lookupUnavailable':
    'No current receive address is available. This can also mean the person is offline or chose not to share.',
  'privateContacts.walletRequiredForSending':
    'Open the wallet you want to send from first.',
  'menu.addressBook': 'Address Book',
  'menu.addressBookDesc': 'Saved addresses',
  'menu.configureWallet': 'Configure wallet',
  'menu.connectionStatus': 'Connection status',
  'menu.export': 'Export',
  'menu.exportDesc': 'Export transactions',
  'menu.footer': 'Made with ❤️ by TEX8',
  'menu.footerAccessibility': 'Made with love by TEX8',
  'menu.footerPrefix': 'Made with',
  'menu.footerBy': 'by',
  'menu.help': 'Help',
  'menu.helpDesc': 'FAQ & Support',
  'menu.locked': 'Locked',
  'menu.myWallet': 'My Wallet',
  'menu.noWalletOpen': 'No wallet open',
  'menu.nodeStatus': 'Node Status',
  'nodeStatus.subtitle':
    'Two global routes: fast block synchronization over Clearnet and every other wallet operation through Tor.',
  'nodeStatus.diagnostics': 'Connection check',
  'nodeStatus.diagnosticsHint':
    'Checks Tor for wallet operations and Clearnet for fast blockchain synchronization separately.',
  'nodeStatus.globalRoutes': 'Global node routes',
  'nodeStatus.globalRoutesHint':
    'These routes apply to every wallet on this device. Every change is saved automatically.',
  'nodeStatus.torRoute': 'Tor connection',
  'nodeStatus.torHint':
    'Wallet operations and private services use the selected daemon through embedded Tor.',
  'nodeStatus.clearnetRoute': 'Clearnet block sync',
  'nodeStatus.clearnetHint':
    'Only public blockchain blocks use the fast Clearnet gRPC route.',
  'nodeStatus.connected': 'Connected',
  'nodeStatus.notConnected': 'Error',
  'nodeStatus.checking': 'Checking',
  'nodeStatus.autoSaved': 'Saved automatically',
  'nodeStatus.autoSaving': 'Saving…',
  'nodeStatus.autoSaveError': 'Check entries',
  'nodeStatus.syncStorage': 'Sync storage',
  'nodeStatus.syncStorageHint':
    'Temporary public blocks are removed as soon as they are scanned. A smaller limit can make the first sync slower.',
  'nodeStatus.syncStorageRestart':
    'Saved. Restart the app before the next sync to apply it.',
  'menu.sharedAiModule': 'Tex8 Assistant',
  'assistant.kicker': 'Tex8 Shared',
  'assistant.title': 'AI Assistant',
  'assistant.placeholder': 'Ask about wallet features…',
  'settings.appearance': 'Appearance',
  'settings.autoLock': 'Auto-lock (5 min)',
  'settings.lockAfterInactivity': 'Lock after inactivity',
  'settings.timeout1Minute': '1 min',
  'settings.timeout5Minutes': '5 min',
  'settings.timeout15Minutes': '15 min',
  'settings.timeout30Minutes': '30 min',
  'settings.timeout1Hour': '1 hour',
  'settings.timeoutNever': 'Never',
  'settings.appProtection': 'Protect your wallet',
  'settings.appProtectionHint': 'One simple check protects all saved wallets.',
  'settings.noProtection': 'No protection',
  'settings.noProtectionActive':
    'No app protection is active. Choose a method below to enable it.',
  'settings.biometrics': 'Biometrics',
  'settings.appPassword': 'App password',
  'settings.setAppPassword': 'Set app password',
  'settings.confirmAppPassword': 'Confirm app password',
  'settings.saveAppProtection': 'Save protection',
  'settings.appProtectionSaved': 'App protection saved.',
  'settings.appProtectionFailed':
    'App protection could not be changed. Nothing was changed.',
  'settings.changeWalletPassword': 'Change wallet password',
  'settings.confirmWalletPassword': 'Confirm new password',
  'settings.createIdentity': 'Create Identity',
  'settings.currencyUsd': 'Currency: USD',
  'settings.daemonTls': 'Daemon TLS',
  'settings.default': 'Default',
  'settings.diagnostics': 'Diagnostics',
  'settings.diagnosticRunFailed':
    'Diagnostics could not be completed. The technical error was written to the app log.',
  'settings.diagnosticPassed': 'Passed',
  'settings.diagnosticWarnings': 'Warnings',
  'settings.diagnosticFailed': 'Failed',
  'settings.diagnosticSkipped': 'Skipped',
  'settings.diagnosticTotal': 'Total test time: {duration} ms',
  'action.skip': 'Skip',
  'security.skipProtectionHint':
    'This choice is remembered. You can enable app protection later in Settings.',
  'diagnostic.category.core': 'Core',
  'diagnostic.category.security': 'Security',
  'diagnostic.category.network': 'Network',
  'diagnostic.category.performance': 'Performance',
  'diagnostic.category.wallet': 'Wallet',
  'diagnostic.category.fastWallet': 'Fast Wallet',
  'diagnostic.category.hardware': 'Hardware',
  'diagnostic.test.nativeCore': 'Native Monero Core',
  'diagnostic.test.secureStorage': 'Protected storage round-trip',
  'diagnostic.test.nodeConfiguration': 'Node configuration',
  'diagnostic.test.sharedConnection': 'Shared blockchain connection',
  'diagnostic.test.scanPack': 'gRPC / ScanPack path',
  'diagnostic.test.throughput': 'Block download throughput',
  'diagnostic.test.walletSnapshot': 'Wallet snapshot',
  'diagnostic.test.multiWallet': 'Multi-wallet fan-out',
  'diagnostic.test.fastWalletIntegrity': 'Fast Wallet local integrity',
  'diagnostic.test.fastWalletHosting': 'Encrypted Fast Wallet hosting',
  'diagnostic.test.derivationEngine': 'Key derivation engine',
  'diagnostic.test.ledgerTransport': 'Ledger transport',
  'diagnostic.metric.backend': 'Backend',
  'diagnostic.metric.productCoreAbi': 'Product Core ABI',
  'diagnostic.metric.productCoreSchema': 'Product Core schema',
  'diagnostic.metric.schema': 'Schema',
  'diagnostic.metric.registry': 'Diagnostic registry',
  'diagnostic.metric.appVaultSchema': 'AppVault state schema',
  'diagnostic.metric.mode': 'Mode',
  'diagnostic.metric.network': 'Network',
  'diagnostic.metric.state': 'State',
  'diagnostic.metric.phase': 'Phase',
  'diagnostic.metric.chainHeight': 'Chain height',
  'diagnostic.metric.targetHeight': 'Target height',
  'diagnostic.metric.transportStarts': 'Transport starts',
  'diagnostic.metric.providerGeneration': 'Provider generation',
  'diagnostic.metric.batches': 'Batches',
  'diagnostic.metric.blocks': 'Blocks',
  'diagnostic.metric.decoded': 'Decoded',
  'diagnostic.metric.networkThroughput': 'Network throughput',
  'diagnostic.metric.payloadThroughput': 'Payload throughput',
  'diagnostic.metric.blockThroughput': 'Block throughput',
  'diagnostic.metric.networkSample': 'Network sample',
  'diagnostic.metric.payloadSample': 'Payload sample',
  'diagnostic.metric.fetchTime': 'Fetch time',
  'diagnostic.metric.walletHeight': 'Wallet height',
  'diagnostic.metric.daemonHeight': 'Daemon height',
  'diagnostic.metric.synchronized': 'Synchronized',
  'diagnostic.metric.registeredWallets': 'Registered wallets',
  'diagnostic.metric.joinedWallets': 'Joined wallets',
  'diagnostic.metric.scanWorkers': 'Scan workers',
  'diagnostic.metric.stalledWallets': 'Stalled wallets',
  'diagnostic.metric.deliveries': 'Deliveries',
  'diagnostic.metric.fastWallets': 'Fast Wallets',
  'diagnostic.metric.hosted': 'Hosted',
  'diagnostic.metric.missingCredentials': 'Missing credentials',
  'diagnostic.metric.missingRegistrations': 'Missing registrations',
  'diagnostic.metric.invalidAssignments': 'Invalid assignments',
  'diagnostic.metric.officialWorker': 'Official Worker',
  'diagnostic.metric.privateWorker': 'Private Worker',
  'diagnostic.metric.invalid': 'Invalid',
  'diagnostic.metric.hostedAssignments': 'Hosted assignments',
  'diagnostic.metric.verifiedWorkers': 'Verified Workers',
  'diagnostic.metric.cpuWorkers': 'CPU workers',
  'diagnostic.metric.transport': 'Transport',
  'diagnostic.metric.devices': 'Devices',
  'diagnostic.value.configured': 'Configured',
  'diagnostic.value.disabled': 'Disabled',
  'diagnostic.value.yes': 'Yes',
  'diagnostic.value.no': 'No',
  'diagnostic.value.none': 'None',
  'diagnostic.value.unknown': 'Unknown',
  'diagnostic.summary.coreReady':
    'The packaged Monero wallet core is linked and callable.',
  'diagnostic.summary.coreMissing': 'The native Monero wallet core is missing.',
  'diagnostic.summary.secureStorageReady':
    'A temporary protected credential was stored, read, and deleted.',
  'diagnostic.summary.secureStorageFailed':
    'Protected storage did not return the temporary credential.',
  'diagnostic.summary.nodeOptimized':
    'Monero Fast Node gRPC and daemon endpoints are configured.',
  'diagnostic.summary.nodeOriginal': 'Original Monero RPC is configured.',
  'diagnostic.summary.nodeIncomplete': 'The active node profile is incomplete.',
  'diagnostic.summary.openWalletForNetwork':
    'Open at least one wallet to test the shared node connection.',
  'diagnostic.summary.sharedState': 'The shared connection is {state}.',
  'diagnostic.summary.sharedReady':
    'One shared connection supplies every open wallet.',
  'diagnostic.summary.sharedPending':
    'The first shared node connection is still pending.',
  'diagnostic.summary.originalPath':
    'The active profile deliberately uses original Monero RPC.',
  'diagnostic.summary.scanPackPending':
    'gRPC is configured, but no authenticated block batch has arrived yet.',
  'diagnostic.summary.scanPackReady':
    'The optimized transport returned decoded shared block batches.',
  'diagnostic.summary.noThroughput':
    'No non-empty block batch has been downloaded in this app session yet.',
  'diagnostic.summary.throughputReady':
    'Measured directly at the Monero node transport.',
  'diagnostic.summary.throughputSmall':
    'Measured, but the latest batch is too small for a stable capacity estimate.',
  'diagnostic.summary.openWalletForSnapshot':
    'Open a wallet to test its local Core snapshot.',
  'diagnostic.summary.snapshotReady':
    'The active wallet returned a consistent local Core snapshot.',
  'diagnostic.summary.snapshotInvalid':
    'The wallet height is inconsistent with the authenticated chain target.',
  'diagnostic.summary.noJoinedWallet':
    'No wallet is currently joined to the shared sync coordinator.',
  'diagnostic.summary.walletStalled': 'At least one wallet scanner is stalled.',
  'diagnostic.summary.fanoutReady':
    'Downloaded batches are delivered to all joined wallet scanners.',
  'diagnostic.summary.noFastWallet': 'No Fast Wallet is configured.',
  'diagnostic.summary.fastWalletReady':
    'Every Fast Wallet has protected local credentials and consistent registration data.',
  'diagnostic.summary.fastWalletInvalid':
    'Fast Wallet registration or protected credential data is incomplete.',
  'diagnostic.summary.noHostedFastWallet':
    'No Fast Wallet currently has hosted encrypted scan data.',
  'diagnostic.summary.hostingReady':
    'Every protected Worker assignment was verified without changing it.',
  'diagnostic.summary.hostingInvalid':
    'At least one encrypted assignment is incomplete or expired.',
  'diagnostic.summary.engineReady':
    'The packaged engine passed the bounded public-vector benchmark.',
  'diagnostic.summary.engineInvalid':
    'The CPU derivation backend did not return a verified result.',
  'diagnostic.summary.ledgerUnsupported':
    'Ledger is not supported on this platform.',
  'diagnostic.summary.ledgerMissing':
    'No Ledger is connected; no permission prompt was opened.',
  'diagnostic.summary.ledgerReady': 'The Ledger transport is available.',
  'diagnostic.summary.ledgerPermission':
    'Ledger is visible, but transport permission is required.',
  'settings.testNotificationTitle': 'Test notification',
  'settings.testNotificationFailed':
    'The test notification could not be sent. The technical error was written to the app log.',
  'settings.testNotificationSentTitle': 'Test notification sent',
  'settings.testNotificationSentBody':
    'FCM token created ({count} characters), App Check and Gateway registration accepted. Firebase accepted a generic test notification for this phone. It contains no wallet or transaction details.',
  'settings.sendingTestNotification': 'Sending test…',
  'settings.sendTestNotification': 'Send test notification',
  'settings.ledgerBalanceVerification': 'Verify Ledger balance',
  'settings.ledgerBalanceVerificationHint':
    'Manually recheck key images after spending from this Ledger on another device.',
  'settings.ledgerBalanceVerifying': 'Verifying with Ledger…',
  'settings.ledgerBalanceVerified':
    'The Ledger-signed spend status was verified and the local balance was updated.',
  'settings.ledgerBalanceFailed':
    'The Ledger balance could not be verified. The technical error was written to the app log.',
  'settings.disabled': 'Disabled',
  'settings.enableBiometrics': 'Enable biometrics',
  'settings.fastReceive': 'Fast Wallet',
  'settings.info': 'Info',
  'settings.language': 'Language',
  'settings.languageCurrent': 'Language: {language}',
  'settings.languageSubtitle': 'Choose the app language.',
  'settings.version': 'Version {version}',
  'settings.scanPerformance': 'Scan performance',
  'settings.scanPerformanceHint':
    'A short one-time device test using public sample data. It never opens a wallet or uses wallet keys.',
  'settings.performanceTestbenchHint':
    'Manual testbench using public sample data. Each supported backend runs for 10 seconds, one after another. It never opens a wallet or uses wallet keys.',
  'settings.runPerformanceTestbench': 'Run performance testbench',
  'settings.performanceTestbenchRunning':
    'Testbench running · measuring available backends…',
  'settings.performanceMeasureFailed':
    'The performance testbench could not be completed.',
  'settings.performanceMeasuring': 'Measuring once…',
  'settings.performanceMeasuringShort': 'Measuring…',
  'settings.performanceMeasured': 'Measured',
  'settings.performanceNotMeasured': 'Not measured',
  'settings.performanceUnavailable': 'Not available',
  'settings.cpuNeonBackend': 'CPU · NEON',
  'settings.performanceBackendProgress': '{backend} · {current}/{total}',
  'settings.performanceSeconds': '{elapsed} / {duration} s',
  'settings.performanceOverallProgress': 'Overall {progress}%',
  'settings.derivationsPerSecond': '{rate} derivations/s',
  'settings.loading': 'Loading',
  'settings.mode': 'Mode',
  'settings.node': 'Node',
  'settings.network': 'Network',
  'settings.nodeModeOriginal': 'Original Node',
  'settings.nodeModeTex8': 'Tex8 Node',
  'settings.nodeModeCustom': 'Custom',
  'settings.availableNodeAddresses': 'Separate node routes',
  'settings.availableNodeAddressesHelp':
    'Choose both routes independently: blockchain blocks sync over Clearnet gRPC; all other daemon requests use the selected Onion address through Tor at 127.0.0.1:9050.',
  'settings.clearnetSyncRoute': 'Blockchain sync · Clearnet',
  'settings.onionDaemonRoute': 'Wallet operations · Tor',
  'settings.clearnetGrpcEndpoint': 'Blockchain sync · Clearnet gRPC',
  'settings.onionDaemonEndpoint': 'Wallet operations · Tor daemon',
  'settings.tex8Node': 'TEX8 Node',
  'settings.communityNode': 'Community Node',
  'settings.clearnetAddress': 'Clearnet',
  'settings.onionAddress': 'Onion',
  'settings.worker': 'Fast Wallet Worker',
  'settings.workerSubtitle':
    'Choose who watches the additional Fast Wallet for incoming payments. Spending keys never leave your wallet.',
  'settings.recommendedWorker': 'Recommended',
  'settings.recommendedWorkerHint':
    'Use the signed TEX8 Worker configured in this app.',
  'settings.communityWorkers': 'Approved Community Workers',
  'settings.communityWorker': 'Community Worker',
  'settings.communityWorkerHint':
    'Only Workers approved in the signed public directory are shown. The app verifies the approval natively.',
  'settings.workerLoading': 'Loading…',
  'settings.workerUnavailable':
    'The Worker directory is temporarily unavailable. Your current choice remains active.',
  'settings.privateWorker': 'Private Worker',
  'settings.privateWorkerHint':
    'Advanced: pair your own Worker from its signed QR code or descriptor.',
  'settings.privateWorkerPlaceholder': 'Paste Worker QR text or descriptor',
  'settings.useWorker': 'Use this Worker',
  'settings.mfwRegistry': 'Monero Name Registry',
  'settings.mfwRegistryHint':
    'Register and manage a simple public .mfw name for a receive address.',
  'settings.projectPage': 'Project Page',
  'settings.projectPageHint':
    'Official Clearnet and Onion addresses, services, and self-hosting.',
  'projectPage.eyebrow': 'Open project',
  'projectPage.title': 'Project Page & Services',
  'projectPage.subtitle':
    'Inspect Monero Fast Wallet, its public services, and the open-source components behind them.',
  'projectPage.addresses': 'Official addresses',
  'projectPage.addressesHint':
    'The same project page is available through the official and independent Community routes.',
  'projectPage.clearnet': 'Clearnet',
  'projectPage.onion': 'Onion',
  'projectPage.copy': 'Copy',
  'projectPage.copied': 'Copied',
  'projectPage.open': 'Open',
  'projectPage.onionHint':
    'Onion links require a Tor-capable browser. Opening any link leaves the wallet app.',
  'projectPage.selfHosting': 'Run it yourself',
  'projectPage.ownNodeTitle': 'Your own Monero Fast Node',
  'projectPage.ownNodeText':
    'You can operate your own node and enter its Clearnet gRPC and Onion daemon routes under Node Status. The app keeps block sync and private wallet traffic separated.',
  'projectPage.ownWorkerTitle': 'Your own Fast Wallet Worker',
  'projectPage.ownWorkerText':
    'You can run a private Worker and pair its signed descriptor under Settings → Fast Wallet Worker. Spending keys never leave your wallet.',
  'projectPage.services': 'Services',
  'projectPage.servicesHint':
    'Short explanations and technical details are available on the project page.',
  'projectPage.serviceWallet': 'Monero Fast Wallet',
  'projectPage.serviceNode': 'Monero Fast Node',
  'projectPage.serviceRelay': 'Relay Service',
  'projectPage.serviceWorker': 'Fast Wallet Worker',
  'projectPage.serviceRegistry': 'Monero Name Registry',
  'projectPage.serviceAll': 'All services',
  'projectPage.sourceCode': 'Source code',
  'settings.grpcEndpoint': 'gRPC endpoint',
  'settings.originalNodeAddress': 'Original node address',
  'settings.originalNodeHelp':
    'Use a normal Monero node. Automatic Fast Wallet detection is not available in this mode.',
  'settings.customNodeHelp':
    'Use your own daemon, optional MFN gRPC endpoint, and optional local proxy.',
  'settings.openSourceLicenses': 'Open source licenses',
  'settings.openWalletFirst': 'Open wallet first',
  'settings.password': 'Password',
  'settings.passwordChangeHint':
    'The new password stays only in this device’s secure storage.',
  'settings.passwordChanged': 'Wallet password changed.',
  'settings.passwordHardware':
    'A Ledger password is managed on the Ledger device.',
  'settings.passwordMinimum': 'Use at least 12 characters.',
  'settings.passwordMismatch': 'The new passwords do not match.',
  'settings.privacyPolicy': 'Privacy policy',
  'settings.proxy': 'Proxy',
  'settings.ready': 'Ready',
  'settings.saved': 'Saved',
  'settings.secureStored': 'Stored securely',
  'settings.security': 'Security',
  'settings.showBackupSeed': 'Show backup seed',
  'settings.recoverySeedDescription':
    'Reveal only while this software wallet is open.',
  'settings.recoverySeedError':
    'The recovery seed could not be read from this wallet.',
  'settings.recoverySeedHardware':
    'The Ledger recovery seed can only be shown on the Ledger device.',
  'settings.recoverySeedTitle': 'Recovery seed',
  'settings.recoverySeedUnavailable': 'Open a software wallet first.',
  'settings.recoverySeedWarning':
    'Write these words down offline. Never share them with anyone.',
  'settings.softwareWalletRequired': 'Software wallet required',
  'settings.storedSecureStorage': 'Stored in device secure storage',
  'settings.fastWalletServerAddress': 'Fast Wallet server',
  'settings.tex8NodeHelp':
    'Use separate optimized routes: fast blockchain sync over Clearnet and the remaining daemon traffic over Onion.',
  'settings.title': 'Settings',
  'settings.trustedDaemon': 'Trusted daemon',
  'settings.unsaved': 'Unsaved',
  'settings.useTor': 'Use Tor',
  'settings.username': 'Username',
  'settings.wallet': 'Wallet',
  'settings.walletPassword': 'Wallet Password',
  'settings.newWalletPassword': 'New wallet password',
  'status.applied': 'Applied',
  'status.creating': 'Creating',
  'status.error': 'Error',
  'status.failed': 'Failed',
  'status.live': 'Live',
  'status.locked': 'Locked',
  'status.missing': 'Missing',
  'status.none': 'None',
  'status.pending': 'Pending',
  'status.ready': 'Ready',
  'status.running': 'Running',
  'status.saved': 'Saved',
  'status.setup': 'Setup',
  'status.unconfirmed': 'Unconfirmed',
  'status.warnings': 'Warnings',
  'wallets.createFastWallet': 'Create Fast Wallet',
  'wallets.backup': 'Back up',
  'wallets.backupRecoveryWords': 'Back up recovery words',
  'wallets.receiveQuickly': 'Receive quickly',
  'wallets.walletNamePlaceholder': 'Wallet name',
  'wallets.fastWalletOriginalDisabled':
    'Switch to Tex8 Node to use automatic Fast Wallet detection.',
  'wallets.fastWalletTex8Only':
    'Fast Wallets are separate wallets. The server detects incoming payments; spending keys stay on this device.',
  'wallets.fastWallets': 'Fast Wallets',
  'wallets.manage': 'Manage wallets',
  'wallets.noFastWallets': 'No Fast Wallet yet.',
  'wallets.noWallets': 'No private wallet yet.',
  'wallets.openFailedTitle': 'Wallet could not be opened',
  'wallets.openFailed': 'The local wallet could not be opened.',
  'wallets.privateWallets': 'Private Wallets',
  'wallets.removeFastWallet': 'Remove Fast Wallet',
  'wallets.removeFastWalletConfirm':
    'Remove {name}? Automatic server scanning will also be disabled.',
  'wallets.removeFromApp': 'Remove from App',
  'wallets.removeBackupTitle': 'Back up recovery words first',
  'wallets.removeBackupDescription':
    'Before removing {name}, write down and confirm its 25 recovery words. The wallet can then be removed from this app.',
  'wallets.removeWallet': 'Remove Wallet',
  'wallets.removeWalletConfirm':
    'Permanently remove the local data for {name}? Without its recovery words or Ledger, access cannot be restored.',
  'wallets.removeFailedTitle': 'Wallet could not be removed',
  'wallets.removeFailed': 'The local wallet data could not be removed.',
  'wallets.subtitle': 'Add, switch, and remove private or Fast Wallets.',
  'wallets.title': 'Wallets',
} as const;

const de: Record<keyof typeof en, string> = {
  'action.addWallet': 'Wallet hinzufügen',
  'action.back': 'Zurück',
  'action.cancel': 'Abbrechen',
  'action.enableNotifications': 'Mitteilungen an',
  'action.clear': 'Löschen',
  'action.close': 'Schließen',
  'action.closeWallet': 'Wallet schließen',
  'action.continue': 'Weiter',
  'action.delete': 'Löschen',
  'action.getStarted': 'Los geht’s',
  'action.copyAddress': 'Adresse kopieren',
  'action.copied': 'Kopiert',
  'action.create': 'Erstellen',
  'action.createIdentity': 'Identität erstellen',
  'action.createWallet': 'Wallet erstellen',
  'action.import': 'Importieren',
  'action.open': 'Öffnen',
  'action.openWallet': 'Wallet öffnen',
  'action.paste': 'Einfügen',
  'action.prepareSend': 'Senden vorbereiten',
  'action.reconnect': 'Neu verbinden',
  'action.retry': 'Erneut versuchen',
  'action.reset': 'Zurücksetzen',
  'action.runDiagnostics': 'Diagnose starten',
  'action.save': 'Speichern',
  'action.change': 'Ändern',
  'action.saving': 'Speichert',
  'action.search': 'Suchen',
  'action.sendNow': 'Jetzt senden',
  'action.share': 'Teilen',
  'action.shared': 'Geteilt',
  'action.showOnLedger': 'Auf Ledger anzeigen',
  'action.unlock': 'Entsperren',
  'action.working': 'Arbeitet...',
  'vanity.title': 'Vanity-Adresse',
  'vanity.subtitle': 'Private individuelle Monero-Adresse erstellen',
  'common.off': 'Aus',
  'common.on': 'Ein',
  'common.optional': 'Optional',
  'common.required': 'Erforderlich',
  'common.wallet': 'Wallet',
  'native.notification.transactions': 'Monero-Transaktionen',
  'native.notification.transactionsDescription':
    'Hinweise zu Fast Wallet-Zahlungen und Bestätigungen',
  'native.notification.sync': 'Wallet-Synchronisierung',
  'native.notification.syncDescription':
    'Hält die Verlaufs-Synchronisierung aktiver Wallets aufrecht',
  'native.notification.syncTitle': 'Wallet-Verlauf wird synchronisiert',
  'native.notification.syncBody':
    'Öffentliche Blockchain-Daten werden geladen und gescannt',
  'native.permission.location':
    'Der Standort wird nur verwendet, wenn du die Monero Enthusiast-Suche in deiner Nähe aktivierst. Die App reduziert ihn auf ein ungefähres Gebiet und zeigt niemals deine genaue Position an.',
  'native.permission.bluetooth':
    'Bluetooth wird zur Verbindung mit Ledger-Nano-Hardware-Wallets verwendet.',
  'native.permission.camera':
    'Der Kamerazugriff wird nur zum Scannen eines QR-Codes mit einer Monero-Empfangsadresse verwendet.',
  'native.permission.faceId':
    'Face ID wird verwendet, um Monero Fast Wallet auf diesem Gerät sicher zu entsperren.',
  'language.de': 'Deutsch',
  'language.en': 'English',
  'tabs.home': 'Home',
  'tabs.community': 'Community',
  'tabs.menu': 'Menü',
  'tabs.receive': 'Empfangen',
  'tabs.send': 'Senden',
  'topBar.connecting': 'Verbindet',
  'topBar.connectingBlocks': 'Block-Sync verbindet',
  'topBar.connectingTor': 'Verbindet mit Tor',
  'topBar.offline': 'Offline',
  'topBar.online': 'Online',
  'topBar.ready': 'Bereit',
  'communityV1.title': 'Monero Enthusiast',
  'communityV1.menuDescription':
    'Demnächst: Kontakte, Chat und Dienstleistungen',
  'communitySoon.eyebrow': 'Demnächst',
  'communitySoon.title': 'Monero Community',
  'communitySoon.subtitle':
    'Ein privater Ort für Kontakte rund um Monero – ohne die Wallet in einen Marktplatz zu verwandeln.',
  'communitySoon.plannedFeatures': 'Geplante Funktionen',
  'communitySoon.bulletinTitle': 'Schwarzes Brett',
  'communitySoon.bulletinText':
    'Teile Hinweise, Ideen, Fragen und lokale Treffen.',
  'communitySoon.meetTitle': 'Leute kennenlernen',
  'communitySoon.meetText':
    'Lerne Menschen in deiner Nähe kennen, verabrede dich oder tausche dich online aus.',
  'communitySoon.matrixTitle': 'Matrix-Chat',
  'communitySoon.matrixText':
    'Führe Unterhaltungen direkt in einem integrierten, privaten Matrix-Chat.',
  'communitySoon.profilesTitle': 'Profile und Dienstleistungen',
  'communitySoon.profilesText':
    'Erstelle ein Profil und beschreibe deine Dienstleistungen. Der direkte Austausch bleibt zwischen den Nutzern.',
  'communitySoon.verifiedTitle': 'Optionale Verifizierung',
  'communitySoon.verifiedText':
    'Verifizierte Nutzer erhalten ein sichtbares Badge, um Identitätsmissbrauch und Betrugsrisiken zu verringern. Die Verifizierung bleibt freiwillig.',
  'communitySoon.verifiedNote':
    'Das Badge ist ein Vertrauenssignal, aber keine Garantie.',
  'communitySoon.verifiedBadge': 'Verifiziert',
  'communitySoon.noMarketplaceTitle': 'Kein Marktplatz',
  'communitySoon.noMarketplaceText':
    'Aus regulatorischen Gründen gibt es in der App keinen Marktplatz, Checkout oder vermittelten Handel. Nutzer können ihre eigenen Dienstleistungen weiterhin im Profil vorstellen.',
  'communityV1.optional': 'Optionale Community',
  'communityV1.subtitle':
    'Finde Menschen und hilfreiche Ideen, ohne sie mit deiner Wallet zu verbinden.',
  'communityV1.walletSeparate': 'Deine Wallet bleibt getrennt',
  'communityV1.walletSeparateText':
    'Dieses Profil erhält niemals deine Wallet-Adresse, dein Guthaben, Transaktionen, Wiederherstellungswörter oder privaten Schlüssel.',
  'communityV1.localSearch': 'Die Suche bleibt auf diesem Gerät',
  'communityV1.localSearchText':
    'Öffentliche Einträge werden heruntergeladen und hier durchsucht. Ergebnisse und deine Nutzung bleiben auf diesem Gerät.',
  'communityV1.privacySettings': 'Community-Datenschutz',
  'communityV1.shareSearches': 'Suchvorschläge gemeinsam verbessern',
  'communityV1.shareSearchesWelcomeText':
    'Standardmäßig eingeschaltet. Abgesendete Suchbegriffe können nach einem Schutzfilter ohne Wallet-Daten geteilt werden. Du kannst das ausschalten.',
  'communityV1.shareSearchesSettingsText':
    'Abgesendete Suchbegriffe ohne Wallet-Daten teilen. E-Mail-Adressen, Wallet-Adressen, Transaktions-IDs, Telefonnummern und Seed-ähnliche Texte werden vorher gefiltert. Nicht abgesendete Eingaben, Ergebnisse und Klicks werden niemals geteilt.',
  'communityV1.shareSearchesSaveFailed':
    'Diese Einstellung konnte nicht gespeichert werden. Der vorherige Wert bleibt aktiv.',
  'communityV1.privateChat': 'Privater Chat zu zweit',
  'communityV1.privateChatText':
    'Nachrichten sind Ende-zu-Ende verschlüsselt. Nur ihr beide könnt sie lesen.',
  'communityV1.yourChoice': 'Du entscheidest',
  'communityV1.yourChoiceText':
    'Der Standort ist freiwillig und nur ungefähr. Du kannst dich verbergen, blockieren, melden oder dein Profil löschen.',
  'communityV1.status': 'Status der privaten Community',
  'communityV1.catalog': 'Lokale Suche',
  'communityV1.privateMessages': 'Private Nachrichten',
  'communityV1.ready': 'Bereit',
  'communityV1.preparing': 'Noch nicht bereit',
  'communityV1.notReady':
    'Diese sichere Community-Version wird für diese Plattform noch vorbereitet. Deine Wallet funktioniert normal.',
  'communityV1.safety':
    'Teile niemals Wiederherstellungswörter, private Schlüssel oder dein Wallet-Passwort mit anderen.',
  'communityV1.openFailed':
    'Die private Community konnte nicht geöffnet werden. Bitte versuche es erneut.',
  'communityV1.createProfile': 'Private Community starten',
  'communityV1.openPrivateChat': 'Private Community öffnen',
  'communityV1.publicProfile': 'Dein öffentliches Profil',
  'communityV1.publicProfileText':
    'Wähle nur einen öffentlichen Namen und eine kurze Beschreibung. Deine Wallet wird niemals verknüpft.',
  'communityV1.publicName': 'Öffentlicher Name',
  'communityV1.publicAbout': 'Über dich',
  'communityV1.reviewStatus': 'Prüfstatus',
  'communityV1.status.awaitingScreening': 'Wartet auf automatische Prüfung',
  'communityV1.status.humanReview': 'Wartet auf menschliche Prüfung',
  'communityV1.status.needsChanges': 'Änderungen erforderlich',
  'communityV1.status.quarantined': 'Zur Sicherheitsprüfung zurückgehalten',
  'communityV1.status.approvedAwaitingEmbedding':
    'Freigegeben · lokale Suche wird vorbereitet',
  'communityV1.status.published': 'Veröffentlicht',
  'communityV1.status.hidden': 'Ausgeblendet',
  'communityV1.status.rejected': 'Nicht freigegeben',
  'communityV1.status.removed': 'Entfernt',
  'communityV1.status.expired': 'Abgelaufen',
  'communityV1.status.withdrawn': 'Zurückgezogen',
  'communityV1.submitReview': 'Zur Prüfung senden',
  'communityV1.profileSubmitted':
    'Dein Profil wurde zur Sicherheitsprüfung gesendet.',
  'communityV1.profileFailed': 'Dein Profil konnte nicht gespeichert werden.',
  'communityV1.productListing': 'Produktangebot erstellen',
  'communityV1.productListingText':
    'Das Angebot wird zur Prüfung an den Community-Server gesendet. Deine Wallet-Daten werden niemals angehängt.',
  'communityV1.productTitle': 'Produkttitel',
  'communityV1.productDescription': 'Beschreibung und wichtige Details',
  'communityV1.productCategories': 'Kategorien',
  'communityV1.productCategoriesHint':
    'Optional. Trenne Kategorien mit Kommas, zum Beispiel: Bücher, Datenschutz.',
  'communityV1.productCategoriesInvalid':
    'Jede Kategorie darf höchstens 64 Zeichen lang sein.',
  'communityV1.submitProduct': 'Produkt zur Prüfung senden',
  'communityV1.productSubmitted':
    'Dein Produktangebot ist jetzt auf dem Server gespeichert und wartet auf die Prüfung.',
  'communityV1.productFailed':
    'Das Produktangebot konnte nicht gesendet werden.',
  'communityV1.discover': 'Menschen und Ideen finden',
  'communityV1.searchLabel': 'Wonach suchst du?',
  'communityV1.noResults': 'Keine passenden öffentlichen Einträge gefunden.',
  'communityV1.searchFailed':
    'Die Suche konnte auf diesem Gerät nicht abgeschlossen werden.',
  'communityV1.clearSearchHistory': 'Letzte Suchanfragen löschen',
  'communityV1.searchHistoryCleared':
    'Die letzten Suchanfragen wurden gelöscht.',
  'communityV1.searchHistoryClearFailed':
    'Die letzten Suchanfragen konnten nicht gelöscht werden.',
  'communityV1.requestContact': 'Kontakt anfragen',
  'communityV1.requestSent': 'Deine private Kontaktanfrage wurde gesendet.',
  'communityV1.contactFailed':
    'Die Kontaktanfrage konnte nicht aktualisiert werden.',
  'communityV1.contacts': 'Private Kontakte',
  'communityV1.contactRequest': 'Jemand möchte Kontakt aufnehmen',
  'communityV1.contactRequestText':
    'Nimm nur an, wenn diese Person dir schreiben darf.',
  'communityV1.decline': 'Ablehnen',
  'communityV1.accept': 'Annehmen',
  'communityV1.noContacts': 'Du hast noch keine privaten Kontakte.',
  'communityV1.privateContact': 'Privater Kontakt',
  'communityV1.openChat': 'Chat öffnen',
  'communityV1.privateConversation': 'Privates Gespräch',
  'communityV1.chatSafety':
    'Nachrichten sind verschlüsselt. Sende niemals Wiederherstellungswörter, private Schlüssel oder Wallet-Passwörter.',
  'communityV1.noMessages': 'Noch keine Nachrichten.',
  'communityV1.messagePlaceholder': 'Nachricht',
  'communityV1.send': 'Senden',
  'communityV1.sendFailed': 'Die Nachricht konnte nicht gesendet werden.',
  'communityV1.chatFailed':
    'Das private Gespräch konnte nicht geöffnet werden.',
  'communityV1.report': 'Diese Nachricht melden',
  'communityV1.reviewReport': 'Genaue Nachricht prüfen',
  'communityV1.reviewReportText':
    'Nur die unten angezeigte Nachricht und deine Begründung werden zur Prüfung gesendet.',
  'communityV1.reportReason': 'Warum meldest du diese Nachricht?',
  'communityV1.confirmReport': 'Meldung senden',
  'communityV1.reportSent': 'Die ausgewählte Nachricht wurde gemeldet.',
  'communityV1.reportFailed': 'Die Meldung konnte nicht gesendet werden.',
  'communityV1.block': 'Kontakt blockieren',
  'communityV1.blockConfirm':
    'Diese Person kann dich danach nicht mehr kontaktieren. Fortfahren?',
  'communityV1.blockFailed': 'Dieser Kontakt konnte nicht blockiert werden.',
  'communityV1.deleteProfile': 'Community-Profil löschen',
  'communityV1.deleteConfirm':
    'Dadurch werden dein optionales Community-Profil und die privaten Chats auf diesem Gerät dauerhaft gelöscht. Deine Wallet bleibt unverändert.',
  'communityV1.deleteFailed':
    'Das Community-Profil konnte nicht gelöscht werden. Auf diesem Gerät wurde nichts entfernt.',
  'communityV1.suspended': 'Community-Profil pausiert',
  'communityV1.suspendedText':
    'Du kannst die Moderationsentscheidung lesen und Einspruch einlegen. Deine Wallet funktioniert normal weiter.',
  'communityV1.reason': 'Begründung',
  'communityV1.moderationDecision': 'Prüfentscheidung',
  'communityV1.decisionPending': 'Die Prüfung läuft noch.',
  'communityV1.appealReason':
    'Warum soll diese Entscheidung erneut geprüft werden?',
  'communityV1.sendAppeal': 'Kostenlosen Einspruch senden',
  'communityV1.appealPending': 'Dein Einspruch wartet auf Prüfung.',
  'communityV1.appealSent': 'Dein Einspruch wurde gesendet.',
  'communityV1.appealFailed': 'Dein Einspruch konnte nicht gesendet werden.',
  'communityV1.enableNotifications': 'Community-Hinweise aktivieren',
  'communityV1.notificationsEnabled':
    'Community-Hinweise sind auf diesem Gerät aktiviert.',
  'communityV1.notificationsFailed':
    'Hinweise konnten nicht aktiviert werden. Du kannst die Community trotzdem nutzen.',
  'sync.error': 'Sync-Fehler',
  'sync.connectingNode': 'Sichere Verbindung zum Monero-Node wird hergestellt',
  'sync.selectingSource': 'Sync-Quelle auswählen',
  'sync.startingConnection':
    'Verbindung zum gewählten Sync-Node wird hergestellt',
  'sync.startingConnectionHint':
    'Der gewählte Sync-Node wird direkt verwendet. Die App bleibt bedienbar.',
  'sync.startingConnectionElapsed':
    '{seconds} Sek. · Direkte Verbindung zum gewählten Sync-Node. Die App bleibt bedienbar.',
  'sync.showDetails': 'Sync-Details anzeigen',
  'sync.hideDetails': 'Sync-Details ausblenden',
  'sync.downloadingBlocks': 'Blöcke herunterladen',
  'sync.scanningWallets': 'Alle Wallets scannen',
  'sync.downloadingAndScanning': 'Blöcke laden und alle Wallets scannen',
  'sync.checkingMempool': 'Ausstehende Transaktionen prüfen',
  'sync.savingWallets': 'Wallet-Stand speichern',
  'sync.retryingNode': 'Node-Verbindung erneut versuchen',
  'sync.failureNodeConfiguration':
    'Die Node-Einstellungen sind unvollständig. Öffne Einstellungen > Node.',
  'sync.failureNodeTimeout':
    'Die Node hat nicht rechtzeitig geantwortet. Neuer Versuch läuft.',
  'sync.failureNodeUnreachable':
    'Die Node ist nicht erreichbar. Prüfe Internet und Node-Einstellungen.',
  'sync.failureNodeSecurity':
    'Die Sicherheits-Einstellungen der Node passen nicht. Prüfe Einstellungen > Node.',
  'sync.failureOptimizedService':
    'Der Fast Wallet-Dienst ist vorübergehend nicht erreichbar. Neuer Versuch läuft.',
  'sync.failureServerResponse':
    'Die Antwort des Sync-Servers konnte nicht verarbeitet werden. Sicherer Neuversuch mit kleineren Paketen läuft.',
  'sync.failureServerResponseShort': 'Sync-Paketgröße wird angepasst',
  'sync.retryAttempt': 'Wiederholungsversuch {count} läuft',
  'sync.failureWalletScan':
    'Der Wallet-Scan benötigt einen neuen Versuch. Dein Guthaben bleibt sicher.',
  'sync.degraded': 'Einige Wallets benötigen einen neuen Versuch',
  'sync.blockchainData': 'Blockchain-Daten',
  'sync.connected': 'Verbunden',
  'sync.sharedPipeline': 'Gemeinsamer Wallet-Sync',
  'sync.walletsTogether': '{count} Wallets nutzen diesen Blockstrom',
  'sync.checkingBlocks': 'Blöcke prüfen',
  'sync.finalizing': 'Letzte Prüfung',
  'sync.verifyingRecent': 'Neueste Transaktionen werden geprüft',
  'sync.coreConfirming': 'Warte auf Wallet-Bestätigung',
  'sync.blockHeight': 'Block {current} von {target}',
  'sync.networkRate': '{rate} Mbit/s',
  'sync.derivationRate': '{rate} Ableitungen/s',
  'sync.fullScanResult': 'Abgeschlossener Vollscan',
  'sync.fullScanAverageNetwork': 'Netzwerk-Durchschnitt: {rate} Mbit/s',
  'sync.fullScanAverageDerivations': 'Scan-Durchschnitt: {rate} Ableitungen/s',
  'sync.fullScanTotalTime': 'Gesamte Scan-Zeit: {duration}',
  'sync.fullScanEndToEnd': 'End-to-End-Durchsatz: {rate} Mbit/s',
  'sync.fullScanWaits':
    '{retries} Neuversuche · Retry/Offline {retry} · Backpressure {backpressure}',
  'sync.blocksRemaining': '{count} Blöcke verbleibend',
  'sync.etaCalculating': 'Restzeit wird berechnet',
  'sync.etaSeconds': 'Noch etwa {count} Sek.',
  'sync.etaMinutes': 'Noch etwa {count} Min.',
  'sync.etaHours': 'Noch etwa {count} Std.',
  'sync.noWallet': 'Keine Wallet',
  'sync.nodeOffline': 'Node offline',
  'sync.offline': 'Offline',
  'sync.opening': 'Öffnen',
  'sync.openWallet': 'Wallet öffnen zum Sync',
  'sync.percent': '{percent}%',
  'sync.sendBalanceNotice':
    'Das Guthaben kann sich vor dem Senden noch ändern.',
  'sync.synced': 'Synchronisiert',
  'sync.syncing': 'Scannen',
  'sync.scanningBlocks': 'Blöcke scannen',
  'sync.updatingHistory': 'Verlauf aktualisieren',
  'sync.waiting': 'Warten',
  'sync.waitingForStatus': 'Vorbereiten',
  'sync.ledgerSigningPreparationRequired': 'Ledger-Vorbereitung erforderlich',
  'sync.ledgerSigningPreparationExplanation':
    'Blockchain und Ansichts-Wallet sind synchronisiert. Im Hintergrund läuft gerade nichts. Verbinde und entsperre den Ledger, öffne darauf die Monero-App und starte dann die Vorbereitung.',
  'sync.prepareLedgerNow': 'Ledger jetzt vorbereiten',
  'sync.wallet': 'Wallet-Sync',
  'sync.spendOutputs': 'Spend-Outputs',
  'sync.spendOutputsChecking': 'Ausgegebene Outputs werden geprüft',
  'sync.spendOutputsNodeRetry':
    'Node-Prüfung der Spend-Outputs wird wiederholt',
  'sync.waitingLedger': 'Warte auf Ledger – entsperren und Monero-App öffnen',
  'sync.connectingLedger': 'Ledger wird verbunden',
  'sync.persistingWallet': 'Geprüfter Wallet-Stand wird gespeichert',
  'sync.recoveringSession': 'Wallet-Sitzung wird wiederhergestellt',
  'sync.walletName': '{wallet}',
  'security.appProtection': 'App-Schutz',
  'security.preparingProtection': 'Sicherer App-Schutz wird vorbereitet…',
  'security.biometricPrompt': 'Monero Fast Wallet entsperren',
  'security.biometricUnavailable':
    'Biometrisches Entsperren ist auf diesem Gerät nicht verfügbar.',
  'security.enterPassword': 'App-Passwort eingeben',
  'security.passwordIncorrect': 'Das App-Passwort ist nicht korrekt.',
  'security.setUpAppProtectionHint':
    'Wähle, wie du die App entsperren möchtest. Du kannst das später in den Einstellungen ändern.',
  'security.useBiometrics': 'Fingerabdruck oder Gesicht',
  'security.biometricsRecommended': 'Empfohlen',
  'security.biometricsFallback':
    'Falls nötig, kannst du den Gerätecode verwenden.',
  'security.useAppPassword': 'App-Passwort',
  'security.passwordAlternative': 'Ein eigenes Passwort verwenden',
  'security.passwordRule':
    'Verwende mindestens 12 Zeichen. Ein kurzer Satz ist am einfachsten zu merken.',
  'security.showPassword': 'Passwort anzeigen',
  'security.hidePassword': 'Passwort verbergen',
  'security.passwordRecoveryHelp':
    'Falsche Passwörter werden zeitlich begrenzt und löschen niemals Wallet-Daten. Bewahre jeden Recovery Seed sicher auf, falls alle App-Entsperrmethoden verloren gehen.',
  'security.passwordAttemptsRemaining':
    'Falsches App-Passwort. Versuche es nach der Sicherheitswartezeit erneut.',
  'security.passwordAttemptRemaining':
    'Falsches App-Passwort. Versuche es nach der Sicherheitswartezeit erneut.',
  'security.passwordResetInProgress':
    'Der App-Zugriff ist vorübergehend begrenzt. Die Wallet-Daten bleiben erhalten.',
  'security.continueWithBiometrics': 'Mit Biometrie fortfahren',
  'security.unlockApp': 'App entsperren',
  'security.unlockAppHint':
    'Einmal entsperren, um alle gespeicherten Wallets zu verwenden.',
  'security.unlockFailed': 'Die App konnte nicht entsperrt werden.',
  'security.unlockWithBiometrics': 'Mit Biometrie entsperren',
  'notification.incomingTitle': 'Eingehendes XMR',
  'notification.incomingAmount': '{amount} XMR eingegangen',
  'notification.incomingWallet': 'Für {wallet}',
  'notification.outgoingTitle': 'XMR ausgegeben',
  'notification.outgoingAmount': '{amount} XMR ausgegeben',
  'notification.outgoingWallet': 'Von {wallet}',
  'notification.closesIn': 'Schließt in {seconds} s',
  'notification.ok': 'OK',
  'send.checkingSpendOutputs': 'Ausgegebene Outputs werden mit Ledger geprüft…',
  'ledgerSigning.connectTitle': 'Ledger verbinden',
  'ledgerSigning.connectedTitle': 'Ledger verbunden',
  'ledgerSigning.instructions':
    'Entsperre den Ledger und öffne die Monero-App. Die Wallet sucht weiter, bis du abbrichst.',
  'ledgerSigning.searching': 'Ledger wird gesucht…',
  'ledgerSigning.connecting': 'Ledger wird sicher verbunden…',
  'ledgerSigning.synchronizingInstructions':
    'Bitte etwas Geduld. Die Wallet gleicht neue Blöcke und ausgebbare Coins mit deinem Ledger ab, damit sicher signiert werden kann. Lass den Ledger entsperrt und die Monero-App geöffnet.',
  'ledgerSigning.synchronizingWallet':
    'Ledger verbunden. Signing-Wallet wird synchronisiert…',
  'ledgerSigning.connected': 'Ledger ist verbunden.',
  'ledgerSigning.preparingRequest':
    'Transaktionsanfrage für Ledger wird vorbereitet…',
  'ledgerSigning.awaitingConfirmation':
    'Anfrage gesendet. Bestätige die Transaktion auf dem Ledger.',
  'send.transactionBroadcastRefreshPending':
    'Transaktion gesendet. Prüfe die Ledger-Spend-Outputs später erneut in den Einstellungen.',
  'walletSelector.active': 'Aktiv',
  'walletSelector.fast': '⚡ FAST',
  'walletSelector.ledgerFast': 'ALTES LEDGER K1',
  'walletSelector.ledgerFastAccount':
    'Ledger-Konto 1 · nur lokal · keine Fast Wallet',
  'walletSelector.fastReady': 'Bereit für Zahlungshinweise',
  'walletSelector.fastReceiveOnly':
    'Fast Wallet kann nach dem Wallet-Sync senden.',
  'walletSelector.locked': 'Gesperrt',
  'walletSelector.localOnly': 'Wird eingerichtet',
  'walletSelector.nodeOffline': 'Node offline',
  'walletSelector.notSpendable': 'Vor dem Senden öffnen und synchronisieren.',
  'walletSelector.openToLoad': 'Öffnen, um Balance zu laden',
  'walletSelector.openToCheckNode': 'Öffnen, um Node zu prüfen',
  'walletSelector.openToSend': 'Öffnen und senden',
  'walletSelector.preparing': 'Wird vorbereitet',
  'walletSelector.ready': 'Bereit',
  'walletSelector.ledgerBalanceNeedsVerification':
    'Einmalige Ledger-Prüfung offen',
  'walletSelector.scanningWallet': 'Wallet wird gescannt',
  'walletSelector.waitingSharedBlocks': 'Wartet auf gemeinsame Blöcke',
  'walletSelector.pushOff': 'Push aus',
  'walletSelector.pushReady': 'Aktiv',
  'walletSelector.receiveTo': 'Empfangen mit',
  'walletSelector.receiveOnly': 'Öffnen und synchronisieren',
  'walletSelector.serverError': 'Aktion nötig',
  'walletSelector.serverMismatch': 'Auf diesem Server einrichten',
  'walletSelector.sendFrom': 'Senden von',
  'walletSelector.syncing': 'Sync',
  'walletSelector.synced': 'Synchron',
  'walletSelector.tex8NodeRequired': 'Tex8 Node nötig',
  'walletSelector.wallets': 'Wallets',
  'fastWallet.status.actionNeeded': 'Aktion nötig',
  'fastWallet.status.activeDescription':
    'Der Fast Wallet-Server überwacht Eingänge rund um die Uhr.',
  'fastWallet.status.activeNoPushDescription':
    'Die automatische Erkennung ist aktiv. Aktiviere Mitteilungen für sofortige Hinweise.',
  'fastWallet.status.errorDescription':
    'Die Adresse funktioniert, aber die automatische Erkennung ist derzeit nicht aktiv.',
  'fastWallet.status.nodeRequiredDescription':
    'Die Adresse funktioniert. Wähle Tex8 Node für die automatische Server-Erkennung.',
  'fastWallet.status.offDescription':
    'Die Adresse funktioniert, aber die automatische Server-Erkennung ist aus.',
  'fastWallet.status.pushErrorDescription':
    'Die Adresse ist aktiv, aber Mitteilungen konnten nicht aktiviert werden.',
  'fastWallet.status.localOnly': 'Nur lokal',
  'fastWallet.status.localOnlyDescription':
    'Diese Empfangsadresse ist bereit. Verbinde sie mit dem Fast Wallet-Server für automatische Zahlungshinweise.',
  'fastWallet.status.legacyBlocked': 'Sicherheitsupdate nötig',
  'fastWallet.status.legacyBlockedDescription':
    'Diese alte Fast Wallet ist gesperrt, weil ihr Seed die Quell-Wallet offenlegen kann. Behalte die Dateien und nutze den geschützten Migrationsweg.',
  'fastWallet.status.paused': 'Fast pausiert',
  'fastWallet.status.serverChangedDescription':
    'Verbinde diese Fast Wallet einmal mit dem ausgewählten Fast Wallet-Server.',
  'fastWallet.status.settingUp': 'Wird eingerichtet',
  'fastWallet.status.settingUpDescription':
    'Die App verbindet diese Adresse mit dem Fast Wallet-Server.',
  'welcome.subtitle': 'Privat, schnell und unter deiner Kontrolle.',
  'welcome.savedWallets': 'Deine Wallets',
  'welcome.walletMode': 'Wallet-Modus',
  'welcome.chooseExperience': 'Standard auswählen',
  'welcome.chooseExperienceDescription':
    'Du kannst die Fast Wallet bei jeder Erstellung einer privaten Wallet ändern. Diese Auswahl aktiviert weder Server-Scans noch Mitteilungen oder Datenfreigaben.',
  'welcome.privacyOnly': 'Nur Privatsphäre',
  'welcome.privacyOnlyDescription':
    'Es wird nur die private Monero-Wallet erstellt. Fast Wallet ist standardmäßig ausgeschaltet.',
  'welcome.privacyComfort': 'Privatsphäre + Komfort',
  'welcome.privacyComfortDescription':
    'Fast Wallet ist bei jeder Erstellung einer privaten Wallet standardmäßig eingeschaltet. Sie ist eine getrennte lokale Wallet mit eigenen Wiederherstellungswörtern.',
  'setup.biometric.checking': 'Gerätesicherheit wird geprüft',
  'setup.biometric.secureDeviceKey': 'Sicherer Geräteschlüssel',
  'setup.biometric.storedSecret':
    'Ein zufälliges lokales Wallet-Passwort wird erstellt und im sicheren Speicher dieses Geräts abgelegt.',
  'setup.biometric.waiting': 'Warte auf den Sicherheitsstatus des Geräts.',
  'setup.createDesc': 'Neue Monero-Wallet generieren',
  'setup.existingWallets': 'Vorhandene Wallets',
  'setup.enthusiastsDescription':
    'Nutze einen ungefähren Bereich, um Menschen in deiner Nähe zu finden, zu chatten und euch privat zu verabreden.',
  'setup.enthusiastsTitle': 'Monero-Begeisterte finden',
  'setup.fastWalletDescription':
    'Erstellt eine getrennte Wallet für Eingangshinweise. Nach dem Backup wird nur diese Wallet beim gewählten Scanner registriert.',
  'setup.fastWalletLedgerDescription':
    'Erstellt eine getrennte Software-Fast Wallet mit eigenen Wiederherstellungswörtern. Ledger-Konto 1 wird nicht verwendet.',
  'setup.fastWalletTitle': 'Fast Wallet erstellen',
  'setup.fastWalletToggle': 'Fast Wallet',
  'setup.fastWalletToggleDescription':
    'Zusätzlich eine getrennte Wallet mit eigenen Wiederherstellungswörtern erstellen. Nach dem Backup wird ihr privater View Key verschlüsselt an den gewählten Scanner für Hinweise übertragen.',
  'setup.fastWalletSlot': 'Fast Wallet-Slot',
  'setup.fastWalletSlotDescription':
    'Standard 199. Wähle 1–999. Ein belegter Slot wird niemals wiederverwendet oder übertragen.',
  'setup.fastWalletSlotRetiredDescription':
    'Nächster sicherer Slot {slot}. Gelöschte Walletdateien sind entfernt. Jeder bereits gehostete Slot bleibt lokal gesperrt, weil früherer View-Zugriff nicht widerrufen werden kann.',
  'setup.fastWalletSlotInvalid':
    'Wähle einen ganzzahligen Fast Wallet-Slot von 1 bis 999.',
  'setup.fastWalletBackupRequired':
    'Die getrennte Fast Wallet wurde erstellt, aber ihre Wiederherstellungswörter müssen noch gesichert werden, bevor ihre Adresse verwendet wird.',
  'setup.fastWalletCreateFailed':
    'Deine private Wallet ist bereit. Die optionale Fast Wallet konnte nicht erstellt werden und kann später unter Wallets hinzugefügt werden.',
  'setup.fastWalletPrimaryBackupFirst':
    'Sichere zuerst die Wiederherstellungswörter der privaten Wallet. Danach kannst du eine Fast Wallet unter Wallets erstellen.',
  'setup.fastWalletTransferSending':
    'Verschlüsselter View Key wird an den Scan-Dienst von Monero Fast Node übertragen…',
  'setup.fastWalletTransferAccepted':
    'Der Scan-Dienst von Monero Fast Node hat den verschlüsselten View Key angenommen.',
  'setup.fastWalletTransferFailed':
    'Der Scan-Dienst von Monero Fast Node hat den verschlüsselten View Key nicht angenommen.',
  'setup.createFastReceive': 'Fast Wallet wird erstellt',
  'setup.device': 'Gerät',
  'setup.footer': 'Entwickelt mit ❤️ von TEX8',
  'setup.footerAccessibility': 'Mit Liebe von TEX8 entwickelt',
  'setup.hardware.connecting': 'Ledger wird verbunden',
  'setup.hardware.checkingHistory': 'Lokaler Wallet-Verlauf wird geprüft',
  'setup.hardware.savingVerifiedBalance':
    'Geprüfter Ledger-Saldo wird gespeichert',
  'setup.hardware.syncingHistory': 'Wallet-Verlauf wird gescannt, Block',
  'setup.hardware.syncingHistoryTitle':
    'Wallet erstellt – Verlauf wird synchronisiert',
  'setup.hardware.verifyingOutputs':
    'Eigene Ausgaben werden mit dem Ledger geprüft',
  'setup.hardware.verifyingTitle': 'Ledger-Wallet wird geprüft',
  'setup.hardware.bleFound': 'Ledger BLE gefunden',
  'setup.hardware.desc': 'Hardware-gestützte Monero-Wallet erstellen',
  'setup.hardware.found': 'Ledger Nano gefunden',
  'setup.hardware.instructions':
    'Verbinde den Ledger Nano per Bluetooth oder USB, entsperre ihn und öffne die Monero-App am Gerät.',
  'setup.hardware.exportViewKeyTitle': 'Auf dem Ledger bestätigen',
  'setup.hardware.exportViewKeyInstructions':
    'Ledger Nano entsperrt lassen und die Monero-App geöffnet halten. Auf dem Ledger „Export view key“ bestätigen. Dieses Fenster schließt automatisch, sobald der Ledger den privaten View Key zurückgibt.',
  'setup.hardware.exportViewKeyWaiting': 'Warte auf den Ledger…',
  'setup.hardware.localViewTitle': 'Ledger zum Anzeigen merken',
  'setup.hardware.localViewDescription':
    'Speichert eine verschlüsselte Nur-Lese-Wallet auf diesem Gerät. Guthaben und Eingänge sind ohne Ledger sichtbar; zum Senden bleibt Ledger erforderlich.',
  'setup.hardware.fastWalletDescription':
    'Zusätzlich eine unabhängige Software-Fast Wallet mit eigenen Wiederherstellungswörtern erstellen. Sie ist nicht Ledger-Konto 1.',
  'setup.hardware.localViewProtectionRequired':
    'Aktiviere zuerst den App-Schutz in den Einstellungen, bevor der Ledger-Lesezugriff auf diesem Gerät gespeichert wird.',
  'setup.biometricFingerprint': 'Fingerabdruck',
  'setup.biometricFingerprintOrFace': 'Fingerabdruck oder Gesichtserkennung',
  'setup.biometricGeneric': 'Biometrie',
  'setup.hardware.looking': 'Suche nach einem verfügbaren Ledger-Transport.',
  'setup.hardware.openReady':
    'Bereit zum Öffnen mit der verbundenen Hardware-Wallet.',
  'setup.hardware.permissionRequired': 'Berechtigung erforderlich',
  'setup.hardware.searching': 'Suche...',
  'setup.hardware.searchingTitle': 'Suche nach Ledger Nano',
  'setup.hardware.transportUnavailable': 'Ledger-Transport nicht verfügbar',
  'setup.hardware.waiting': 'Warte auf Ledger Nano',
  'setup.importDesc': 'Aus Monero-Seed wiederherstellen',
  'setup.importWallet': 'Wallet importieren',
  'setup.importing': 'Wallet wird importiert',
  'setup.method.password': 'Passwort',
  'setup.opening': 'Wallet wird geöffnet',
  'setup.passwordConfirm': 'Passwort bestätigen',
  'setup.passwordMismatch': 'Passwörter stimmen nicht überein.',
  'setup.prompt.createDeviceNoBiometric':
    'Mit einem lokalen sicheren Geräteschlüssel erstellen. Du sicherst danach einen 25-Wörter-Seed.',
  'setup.prompt.createDeviceWithBiometric':
    '{biometric} verwenden. Du sicherst danach einen 25-Wörter-Seed.',
  'setup.prompt.createPassword':
    'Wähle ein lokales Passwort. Du sicherst danach einen 25-Wörter-Seed.',
  'setup.prompt.openHardware':
    'Verbinde den Ledger Nano, entsperre ihn und öffne die Monero-App am Gerät.',
  'setup.prompt.openPassword':
    'Gib das Passwort für die lokale Wallet-Datei ein.',
  'setup.prompt.openStored':
    'Bestätige mit {biometric}, um die lokale Wallet-Datei zu entsperren.',
  'setup.prompt.missingCredential':
    'Dieser Wallet fehlt der geschützte Geräteschlüssel. Stelle sie mit den Wiederherstellungswörtern wieder her, um eine neue lokale Kopie zu erstellen.',
  'setup.prompt.restore':
    'Füge deinen 25-Wörter-Monero-Seed ein und wähle ein lokales Passwort.',
  'setup.prompt.restoreStored':
    'Füge deinen 25-Wörter-Monero-Seed ein. Diese Wallet verwendet deine App-Sicherheitseinstellung.',
  'setup.restoreHeight': 'Restore-Höhe (optional)',
  'setup.restoreHeightError': 'Restore-Höhe muss eine Zahl sein.',
  'setup.scanStart': 'Synchronisierung starten ab',
  'setup.scanAutomatic': 'Automatisch (empfohlen)',
  'setup.scanRequired': 'Datum auswählen',
  'setup.scanDateHint':
    'Optional. Die Wallet beginnt etwas vor diesem Datum, damit am gewählten Datum keine Zahlung übersehen wird.',
  'setup.ledgerScanDateHint':
    'Für Ledger erforderlich. Wähle ein Datum vor der ersten Transaktion; nur bei einer ganz neuen Ledger-Wallet wählst du heute.',
  'setup.ledgerConnectBeforeOpen':
    'Verbinde einen Ledger Nano, bevor du diese Wallet öffnest.',
  'setup.fastWalletSlotOccupied':
    'Fast Wallet-Slot {slot} kann nicht wiederverwendet werden. Wurde seine Wallet gelöscht, sind die lokalen Dateien entfernt; der Slot bleibt gesperrt, weil ein früher gewährter Lesezugriff nicht zurückgenommen werden kann. Wähle einen anderen Slot.',
  'setup.fastWalletFileExists':
    'Für Slot {slot} existiert bereits eine lokale Fast Wallet-Datei. Wähle einen anderen Slot oder stelle die bestehende Wallet wieder her; nichts wurde überschrieben.',
  'setup.fastWalletAppLocked':
    'Die App wurde gesperrt, bevor die Fast Wallet fertig erstellt war. Entsperre sie und füge die Fast Wallet unter Wallets hinzu.',
  'setup.fastWalletNodeUnavailable':
    'Die Node-Höhe war für die sichere Erstellung der Fast Wallet noch nicht bereit. Deine private Wallet ist bereit; verbinde dich erneut und füge die Fast Wallet unter Wallets hinzu.',
  'setup.fastWalletStorageUnavailable':
    'Der sichere lokale Speicher konnte die Erstellung der Fast Wallet nicht abschließen. Deine private Wallet ist bereit und kein Schlüssel wurde übertragen.',
  'setup.fastWalletCreationFailed':
    'Die Erstellung der Fast Wallet ist fehlgeschlagen ({reason}). Deine private Wallet ist bereit und kein Schlüssel wurde übertragen. Du kannst es unter Wallets erneut versuchen.',
  'setup.scanDateError':
    'Wähle ein gültiges Datum, das nicht in der Zukunft liegt.',
  'setup.seedConfirm': 'Ich habe diese 25 Wörter offline gesichert.',
  'setup.seedFullError': 'Gib den vollständigen 25-Wörter-Monero-Seed ein.',
  'setup.seedPhrase': 'Seed-Phrase',
  'setup.seedSubtitle':
    'Schreibe alle 25 Wörter auf, bevor du die Wallet verwendest.',
  'setup.seedSubtitleDynamic':
    'Schreibe alle {count} Wörter exakt wie angezeigt auf.',
  'setup.seedTitle': 'Recovery Seed',
  'setup.step.derivingKeys': 'Schlüssel werden abgeleitet',
  'setup.step.encryptingSeed': 'Seed wird verschlüsselt',
  'setup.step.generatingEntropy': 'Entropie wird generiert',
  'setup.step.loadingWallet': 'Wallet wird geladen',
  'setup.step.openingWallet': 'Wallet wird geöffnet',
  'setup.step.openingMoneroApp': 'Monero-App wird geöffnet',
  'setup.step.preparingBackup': 'Backup wird vorbereitet',
  'setup.step.preparingScan': 'Scan wird vorbereitet',
  'setup.step.preparingStorage': 'Speicher wird vorbereitet',
  'setup.step.preparingSync': 'Sync wird vorbereitet',
  'setup.step.preparingWalletFile': 'Wallet-Datei wird vorbereitet',
  'setup.step.readingLocalState': 'Lokaler Status wird gelesen',
  'setup.step.readingPublicKeys': 'Öffentliche Schlüssel werden gelesen',
  'setup.step.restoringSeed': 'Seed wird wiederhergestellt',
  'setup.step.savingWallet': 'Wallet wird gespeichert',
  'setup.step.startingScan': 'Scan wird gestartet',
  'setup.step.waitingForLedger': 'Warte auf Ledger Nano',
  'setup.subtitle': 'Erstellen, importieren oder Ledger Nano verbinden.',
  'setup.title': 'Wallet einrichten',
  'home.all': 'Alle',
  'home.allWallets': 'Alle Wallets',
  'home.balance': 'Mein Guthaben',
  'home.chartLoading': 'Marktchart wird geladen…',
  'home.chartUnavailable': 'Marktchart ist derzeit nicht verfügbar.',
  'home.priceUnavailable': 'Der XMR-Marktpreis ist derzeit nicht verfügbar.',
  'home.updatesTitle': 'Offizielle Monero-Updates',
  'home.updatesSource': 'MONERO PROJECT · GITHUB',
  'home.updatesSourceLink': 'Quelle öffnen',
  'home.updatesLoading': 'Offizielle Updates werden geladen…',
  'home.updatesUnavailable': 'Offizielle Updates sind derzeit nicht verfügbar.',
  'home.newsTitle': 'Monero-News',
  'home.newsSource': 'TEX8 · LIVE-NEWS',
  'home.newsSourceLink': 'Alle News',
  'home.newsLoading': 'Aktuelle Monero-News werden geladen…',
  'home.newsUnavailable': 'News sind derzeit nicht verfügbar.',
  'home.newsEmpty': 'In dieser Kategorie gibt es noch keine News.',
  'home.newsAll': 'Alle',
  'home.newsNetwork': 'Netzwerk',
  'home.newsWallet': 'Wallet',
  'home.newsEcosystem': 'Ökosystem',
  'home.newsReadMore': 'Artikel öffnen',
  'advertising.advertisement': 'Werbeanzeige',
  'advertising.sponsored': 'Gesponsert',
  'advertising.paidBy': 'Bezahlt von {advertiser}',
  'advertising.learnMore': 'Mehr erfahren',
  'advertising.why': 'Warum sehe ich das?',
  'advertising.reasonContextual':
    'Auf diesem Gerät für diesen Bereich ausgewählt. Es wurden weder der Anzeigeverlauf noch Wallet-Daten an den Server gesendet.',
  'advertising.reasonLocal':
    'Auf diesem Gerät anhand deiner privaten lokalen Interessen sortiert. Interessenprofil und Anzeigeverlauf verlassen das Gerät nie.',
  'home.createOrImport': 'Erstellen oder importieren',
  'home.loadingBalance': 'Guthaben wird geladen',
  'home.lockedBalance': 'Noch gesperrt: {amount} XMR',
  'home.noTransactions': 'Noch keine Transaktionen',
  'home.noTransactionsText':
    'Aktivität erscheint hier, nachdem die Wallet passende Outputs gescannt hat.',
  'home.fastWalletTransactionsTitle': 'Fast Wallet-Überwachung aktiv',
  'home.fastWalletTransactionsText':
    'Eingänge werden vom Fast Wallet-Server überwacht. Diese Wallet muss dafür lokal nicht geöffnet sein.',
  'home.noWallet': 'Keine Wallet',
  'home.openWalletToLoad':
    'Öffne oder erstelle eine Wallet, um private Aktivität zu laden.',
  'home.pending': '{amount} XMR ausstehend',
  'home.received': 'Empfangen',
  'home.sent': 'Gesendet',
  'home.timeframeMax': 'Max',
  'home.timeframeToday': 'Heute',
  'home.totalBalance': 'Gesamtguthaben',
  'home.marketPrice': 'Monero-Marktpreis',
  'home.ledgerBalanceNeedsVerification':
    'Die einmalige Ledger-Erstprüfung ist noch offen. Ledger entsperren und darauf die Monero-App öffnen; die Prüfung läuft automatisch.',
  'home.ledgerBalanceVerificationHint':
    'Ledger verbinden und entsperren, darauf die Monero-App öffnen und prüfen, welche Outputs zum Senden verfügbar sind.',
  'home.verifyLedgerBalance': 'Mit Ledger prüfen',
  'home.verifyingLedgerBalance': 'Warte auf Ledger…',
  'home.ledgerReconciliation.connecting-ledger': 'Ledger wird gesucht…',
  'home.ledgerReconciliation.checking-local-scan':
    'Lokaler Wallet-Scan wird geprüft…',
  'home.ledgerReconciliation.catching-up-local-scan':
    'Lokaler Scan läuft vor der Ledger-Prüfung…',
  'home.ledgerReconciliation.deriving-owned-output-key-images':
    'Eigene Outputs werden mit Ledger geprüft…',
  'home.ledgerReconciliation.saving-ledger-balance':
    'Geprüftes Guthaben wird gespeichert…',
  'home.ledgerWalletCouldNotOpen':
    'Die lokale Ledger-Begleitwallet konnte nicht geöffnet werden.',
  'home.transactions': 'Transaktionen',
  'home.walletLocked': 'Wallet gesperrt',
  'home.walletNotOpen': 'Wallet nicht geöffnet',
  'send.addressBook': 'Adressbuch',
  'send.addressBookHint':
    'Gespeicherte Adresse wählen oder für später hinzufügen.',
  'send.addContact': 'Adresse hinzufügen',
  'send.amount': 'Betrag',
  'send.all': 'Alles',
  'send.amountAboveBalance': 'Betrag liegt über dem entsperrten Guthaben.',
  'send.available': 'Verfügbar',
  'send.confirmDetails': 'Bestätige die Details der privaten Überweisung.',
  'send.contacts': 'Kontakte',
  'send.contactDetailsRequired': 'Gib einen Namen und eine Monero-Adresse ein.',
  'send.contactName': 'Name',
  'send.enterValidAmount': 'Gib einen gültigen XMR-Betrag ein.',
  'send.feePrepared':
    'Gebühr vorbereitet. Bitte noch einmal prüfen und dann senden.',
  'send.feePreparedBeforeBroadcast': 'Gebühr wird vor Broadcast vorbereitet',
  'send.fee': 'Gebühr',
  'send.networkFee': 'Netzwerkgebühr',
  'send.priority': 'Gebührenpriorität',
  'send.priorityHigh': 'Hoch',
  'send.priorityLow': 'Niedrig',
  'send.priorityMedium': 'Mittel',
  'send.priorityNormal': 'Normal',
  'send.noRecent': 'Keine letzten Überweisungen',
  'send.noRecentText':
    'Synchronisierte Wallet-Aktivität erscheint hier, nachdem die Wallet geöffnet wurde.',
  'send.noSavedContacts':
    'Noch keine gespeicherten Adressen. Füge unten eine hinzu oder füge eine Adresse ein.',
  'send.noRecipient': 'Kein Empfänger ausgewählt',
  'send.invalidRecipientForNetwork':
    'Diese Adresse passt nicht zum ausgewählten Monero-Netzwerk.',
  'send.mfwUnavailable':
    'Dieser Wallet-Name kann gerade nicht sicher geprüft werden. Bitte um die Monero-Adresse oder den QR-Code.',
  'send.openWalletBeforePreparing':
    'Öffne oder erstelle eine Wallet, bevor du eine Überweisung vorbereitest.',
  'send.openWalletBeforeSending':
    'Öffne oder erstelle eine Wallet, bevor du sendest.',
  'send.pasteAddress': 'Monero-Adresse einfügen',
  'send.resolvingMfwName': 'Wallet-Name wird gesucht…',
  'send.resolvedMfwAddress': 'Aufgelöste Monero-Adresse',
  'send.useMfwSuggestion': '{name} verwenden',
  'send.manualRecipient': 'Adresse manuell eingeben',
  'send.manualRecipientHint':
    'Adresse einfügen oder gespeicherten Kontakt wählen.',
  'send.or': 'oder',
  'send.scanAddress': 'QR-Code scannen',
  'send.scanAddressHint': 'Halte die Kamera auf den QR-Code des Empfängers.',
  'send.scanCameraDenied':
    'Für das Scannen einer Monero-Empfangsadresse wird Kamerazugriff benötigt.',
  'send.scanCameraUnavailable':
    'Auf diesem Gerät ist keine Kamera verfügbar. Füge die Adresse stattdessen ein.',
  'send.scanFailed':
    'Die Kamera konnte nicht gestartet werden. Füge die Adresse stattdessen ein.',
  'send.scanHint':
    'Halte die Kamera auf den QR-Code einer Monero-Empfangsadresse.',
  'send.scanInvalid': 'Dieser QR-Code enthält keine Monero-Adresse.',
  'send.saveContact': 'Adresse speichern',
  'send.openSettings': 'Einstellungen öffnen',
  'send.privacy': 'Privatsphäre',
  'send.privacyDetails':
    'Sender, Empfänger und Betrag bleiben on-chain verborgen.',
  'send.privateTransfer': 'Private Überweisung',
  'send.preparedNext': 'Wird vorbereitet',
  'send.recentTransactions': 'Letzte Transaktionen',
  'send.recentContacts': 'Zuletzt verwendet',
  'send.recipient': 'Empfänger',
  'send.recipientHidden': 'Empfänger verborgen',
  'send.reviewPayment': 'Zahlung prüfen',
  'send.sendXmr': 'XMR senden',
  'send.stealthAddress': 'Stealth-Adresse',
  'send.subtitle':
    'Füge eine Monero-Adresse ein und prüfe vor dem Senden alles.',
  'send.sweepAll':
    'Die native Wallet berechnet den exakten Maximalbetrag nach der Netzwerkgebühr.',
  'send.title': 'XMR senden',
  'send.total': 'Gesamt',
  'send.transactionBroadcast': 'Transaktion gesendet.',
  'send.transactionBroadcastFailed': 'Transaktion konnte nicht gesendet werden',
  'send.transactionPreparationFailed':
    'Transaktion konnte nicht vorbereitet werden',
  'send.successTitle': 'Transaktion gesendet',
  'send.successSubtitle':
    'Deine Transaktion wurde signiert und an das Monero-Netzwerk gesendet.',
  'send.successRefreshing':
    'Saldo und Transaktionsverlauf werden aktualisiert…',
  'send.successReady': 'Saldo und Transaktionsverlauf wurden aktualisiert.',
  'send.successDone': 'Fertig',
  'send.waitForSync':
    'Warte vor dem Senden, bis diese Wallet synchronisiert ist.',
  'send.viewMore': 'Mehr anzeigen',
  'send.checkRecipientTitle': 'Empfänger prüfen',
  'send.checkRecipientDescription':
    'Vergleiche Name und vollständige Adresse, bevor du einen Betrag eingibst.',
  'send.checkRecipientHint':
    'Die Adresse wurde für das ausgewählte Monero-Netz geprüft. Es wird noch nichts gesendet.',
  'send.useThisRecipient': 'Diesen Empfänger verwenden',
  'send.confirmChangedAddress': 'Ich erkenne die neue Adresse',
  'send.fullAddress': 'Vollständige Adresse',
  'send.addressFingerprint': 'Kurzer Adresscheck',
  'send.resolutionSource': 'Gefunden über',
  'send.sharingFreshness': 'Status der Kontaktfreigabe',
  'send.sharedUntil': 'Aktuell bis {date}',
  'send.addressChangedWarning':
    'Diese Person teilt jetzt eine andere Empfangsadresse als die, die du zuvor bestätigt hast. Frage bei ihr nach, bevor du fortfährst.',
  'send.privateContactWrongNetwork':
    'Diese private Kontaktadresse gehört zu einem anderen Monero-Netz.',
  'send.privateContactUnavailable':
    'Diese private Kontaktadresse ist nicht mehr verfügbar. Prüfe die Person erneut.',
  'send.sourceManual': 'Adresse manuell eingegeben',
  'send.sourceQr': 'QR-Code gescannt',
  'send.sourceAddressBook': 'Gespeichertes Adressbuch',
  'send.sourceMfwName': 'Öffentlicher .mfw-Name',
  'send.sourcePaymentLink': 'Geprüfter Zahlungslink',
  'send.sourcePrivateContact': 'Privater Telefonkontakt',
  'send.paymentLinkErrorTitle': 'Zahlungslink nicht verfügbar',
  'send.paymentLinkInvalid':
    'Dieser Zahlungslink ist ungültig oder abgelaufen. Bitte um einen neuen Link.',
  'send.paymentLinkUnavailable':
    'Dieser Zahlungslink konnte nicht sicher geladen werden. Versuche es später erneut.',
  'transactions.account': 'Konto',
  'transactions.amount': 'Betrag',
  'transactions.blockHeight': 'Blockhöhe',
  'transactions.confirmations': 'Bestätigungen',
  'transactions.confirmationsShort': '{count} Best.',
  'transactions.confirmed': 'Bestätigt',
  'transactions.copyId': 'Transaction-ID kopieren',
  'transactions.date': 'Datum',
  'transactions.description': 'Beschreibung',
  'transactions.details': 'Transaktionsdetails',
  'transactions.direction': 'Richtung',
  'transactions.fee': 'Netzwerkgebühr',
  'transactions.hiddenAddress': 'Adresse durch Monero verborgen',
  'transactions.label': 'Bezeichnung',
  'transactions.miningReward': 'Mining-Belohnung',
  'transactions.notFound': 'Transaktion nicht gefunden.',
  'transactions.openDetails': 'Transaktionsdetails öffnen',
  'transactions.openWalletToLoad':
    'Öffne diese Wallet, um ihre Transaktionshistorie zu laden.',
  'transactions.paymentId': 'Payment-ID',
  'transactions.selfTransfer': 'Selbstüberweisung',
  'transactions.status': 'Status',
  'transactions.subaddresses': 'Unteradressen',
  'transactions.title': 'Alle Transaktionen',
  'transactions.transactionId': 'Transaction-ID',
  'transactions.transfer': 'Überweisung',
  'transactions.transferNumber': 'Überweisung {count}',
  'transactions.transfers': 'Überweisungsdetails',
  'transactions.type': 'Typ',
  'transactions.unlockTime': 'Entsperrzeit',
  'transactions.viewMore': 'Mehr anzeigen',
  'transactions.loadMore': 'Mehr laden',
  'transactions.wallet': 'Wallet',
  'receive.addressLabel': 'DEINE MONERO-ADRESSE',
  'receive.addresses': 'Adressen',
  'receive.amountOptional': 'Betrag (optional)',
  'receive.checkDevice': 'Gerät prüfen',
  'receive.connected': 'Verbunden',
  'receive.emptyText':
    'Öffne oder erstelle eine Wallet, um deine Empfangsadresse anzuzeigen.',
  'receive.backupFastWalletFirst': 'Diese Fast Wallet zuerst sichern',
  'receive.backupFastWalletText':
    'Ihre Empfangsadresse bleibt verborgen, bis du bestätigst, dass die Wiederherstellungswörter sicher gesichert sind.',
  'receive.backupNow': 'Jetzt sichern',
  'receive.hardwareAddressConfirmed': 'Adresse wurde am Ledger Nano bestätigt.',
  'receive.hardwareConfirmAddress':
    'Bestätige die Adressanfrage am Ledger Nano.',
  'receive.hardwareConnected': 'Ledger Nano ist verbunden.',
  'receive.hardwareConnectUnlock':
    'Verbinde und entsperre den Ledger Nano, dann öffne die Monero-App.',
  'receive.hardwareNotChecked': 'Ledger-Status wurde noch nicht geprüft.',
  'receive.ledgerFastWallet': 'Ledger Fast Wallet',
  'receive.newAddress': 'Neue Adresse',
  'receive.newAddressLabel': 'Adresse {count}',
  'receive.newAddressName': 'Bezeichnung der Adresse',
  'receive.newAddressPlaceholder': 'Zum Beispiel: Ersparnisse oder Rechnung',
  'receive.subaddressPrivacyHint':
    'Jede Adresse gehört zu dieser Wallet und wird durch dieselben Wiederherstellungswörter wiederhergestellt.',
  'receive.manageAddresses': 'Empfangsadressen verwalten',
  'receive.otherAddresses': 'Weitere Empfangsadressen',
  'receive.paymentLink': 'Monero-Payment-Link',
  'receive.copyPaymentLink': 'Link kopieren',
  'receive.paymentLinkCopied': 'Link kopiert',
  'receive.paymentLinkError':
    'Der sichere Payment-Link konnte nicht erstellt werden. Prüfe Tor und versuche es erneut.',
  'receive.sharePaymentLink': 'Payment-Link teilen',
  'receive.privacyText':
    'Jede Transaktion ist automatisch privat. Sender, Empfänger und Betrag sind nie sichtbar.',
  'receive.primaryAddress': 'Hauptadresse',
  'receive.privacyTitle': 'Privat per Standard',
  'receive.stealthText':
    'Du kannst dieselbe Adresse mehrfach verwenden. Monero erzeugt automatisch einmalige Stealth-Adressen.',
  'receive.stealthTitle': 'Stealth-Adressen',
  'receive.subtitle': 'Teile deine Adresse, um XMR zu empfangen',
  'receive.title': 'Empfangen',
  'receive.usdRateUnavailable': 'Der XMR/USD-Kurs ist derzeit nicht verfügbar.',
  'receive.walletLocked': 'Wallet gesperrt',
  'receive.noWalletOpen': 'Keine Wallet geöffnet',
  'enthusiasts.disabledText':
    'Aktiviere die Suche, wenn du dich mit Menschen in deiner Nähe austauschen möchtest.',
  'enthusiasts.disabledTitle': 'Suche ist ausgeschaltet',
  'enthusiasts.emptyText':
    'Menschen aus demselben ungefähren Gebiet erscheinen hier, ohne ihren genauen Standort zu zeigen.',
  'enthusiasts.emptyTitle': 'Noch niemand in deiner Nähe',
  'enthusiasts.locationRetry': 'Ungefähren Standort erlauben',
  'enthusiasts.debugGps': 'DEBUG · GPS',
  'enthusiasts.debugLocalOnly':
    'Nur zu Testzwecken auf diesem Gerät sichtbar. Genaue Koordinaten werden weder gespeichert noch geteilt.',
  'enthusiasts.myListing': 'MEIN EINTRAG',
  'enthusiasts.listingVisible': 'Im Umkreis von {radius} km sichtbar',
  'enthusiasts.removeListing': 'Eintrag entfernen',
  'enthusiasts.removeListingTitle': 'Deinen Eintrag entfernen?',
  'enthusiasts.removeListingDescription':
    'Du wirst nicht mehr in der Nähe angezeigt. Dein anonymes Konto und deine Kontakte bleiben erhalten.',
  'enthusiasts.menuDescription': 'In der Nähe austauschen und privat treffen',
  'enthusiasts.nearby': 'In deiner Nähe',
  'enthusiasts.privacy':
    'Es wird nur ein grobes Gebiet verwendet. Genauer Standort, Wallet-Adressen, Guthaben und Transaktionen sind niemals Teil der Suche.',
  'enthusiasts.radius': 'SUCHRADIUS',
  'enthusiasts.status.denied': 'Standortfreigabe ist ausgeschaltet',
  'enthusiasts.status.error': 'Standort konnte nicht aktualisiert werden',
  'enthusiasts.status.not_requested':
    'Ungefährer Standort ist noch nicht bereit',
  'enthusiasts.status.off': 'Für andere nicht sichtbar',
  'enthusiasts.status.ready': 'Im ungefähren Gebiet sichtbar',
  'enthusiasts.status.requesting': 'Ungefähres Gebiet wird ermittelt',
  'enthusiasts.status.unavailable': 'Standort ist derzeit nicht verfügbar',
  'enthusiasts.subtitle':
    'Finde Menschen in deiner Nähe, ohne den genauen Standort zu teilen.',
  'enthusiasts.title': 'Monero Enthusiast',
  'enthusiasts.visibility': 'In der Nähe sichtbar',
  'enthusiasts.accept': 'Annehmen',
  'enthusiasts.acceptedContact': 'Bestätigter Kontakt',
  'enthusiasts.block': 'Blockieren',
  'enthusiasts.chat': 'Chat',
  'enthusiasts.chatEmpty': 'Schreib eine erste Nachricht, wenn du bereit bist.',
  'enthusiasts.connect': 'Kontakt',
  'enthusiasts.connections': 'Kontakte',
  'enthusiasts.deleteAction': 'Community-Profil löschen',
  'enthusiasts.deleteDescription':
    'Dein anonymes Profil, deine Kontakte und Nachrichten werden vom Community-Server gelöscht.',
  'enthusiasts.deleteTitle': 'Community-Profil löschen?',
  'enthusiasts.contact.connected': 'Bestätigter Kontakt',
  'enthusiasts.contact.incoming': 'Möchte Kontakt aufnehmen',
  'enthusiasts.contact.outgoing': 'Anfrage gesendet',
  'enthusiasts.distance': 'Etwa {distance} km entfernt',
  'enthusiasts.messagePlaceholder': 'Nachricht',
  'enthusiasts.namePlaceholder': 'Dein öffentlicher Alias',
  'enthusiasts.noConnections': 'Noch keine bestätigten Kontakte.',
  'enthusiasts.report': 'Melden',
  'enthusiasts.requested': 'Angefragt',
  'enthusiasts.safety': 'Sicherheit',
  'enthusiasts.serverError':
    'Die Community ist vorübergehend nicht erreichbar. Prüfe die Verbindung und versuche es erneut.',
  'enthusiasts.yourName': 'DEIN ÖFFENTLICHER ALIAS',
  'mfwNames.activationPending':
    'Die Namensregistrierung ist in dieser Version noch nicht aktiv. Zuerst müssen die signierte Adresse der Monero Fast Wallet Registry und alle Genesis-Parameter des Protokolls festgeschrieben werden.',
  'mfwNames.address': 'Empfangsadresse',
  'mfwNames.addressLoadFailed':
    'Die Wallet-Adressen konnten nicht geladen werden.',
  'mfwNames.chooseWalletAddress': 'Aus Wallet wählen',
  'mfwNames.enterAddressManually': 'Manuell eingeben',
  'mfwNames.manualAddress': 'Manuelle Monero-Adresse',
  'mfwNames.manualAddressPlaceholder':
    'Beliebige Monero-Adresse einfügen oder eingeben',
  'mfwNames.invalidAddress':
    'Gib eine gültige Monero-Adresse für dieses Netzwerk ein.',
  'mfwNames.availabilityAvailable':
    'Am aktuell verifizierten Chain-Tip verfügbar.',
  'mfwNames.availabilityAvailableAgain':
    'Für eine neue Registrierung verfügbar, weil der vorherige Eintrag nicht mehr aktiv ist.',
  'mfwNames.availabilityChecking':
    'Verfügbarkeit wird beim öffentlichen Resolver geprüft…',
  'mfwNames.availabilityPending':
    'Für diesen Namen läuft derzeit eine vorläufige Registrierung.',
  'mfwNames.availabilityRequired':
    'Ein aktuelles, verifiziertes Verfügbarkeitsergebnis ist erforderlich.',
  'mfwNames.availabilityReserved':
    'Dieser vom Protokoll reservierte Name kann nicht registriert werden.',
  'mfwNames.availabilityTaken': 'Dieser Name ist bereits registriert.',
  'mfwNames.availabilityUnavailable':
    'Die Verfügbarkeit kann derzeit nicht sicher verifiziert werden. Die Registrierung bleibt gesperrt.',
  'mfwNames.checkedAt': 'Prüfzeitpunkt',
  'mfwNames.checkedChainTip': 'Geprüfter Chain-Tip',
  'mfwNames.estimatedExpiredAt': 'Voraussichtlich abgelaufen am',
  'mfwNames.estimatedValidUntil': 'Voraussichtlich gültig bis',
  'mfwNames.cancelRenewal': 'Abbrechen',
  'mfwNames.chooseAddress': 'Wähle eine Empfangsadresse für diesen Namen aus.',
  'mfwNames.claimYourAddress': 'Deinen Adressnamen registrieren',
  'mfwNames.ticker': 'Sichere dir jetzt deinen .mfw-Namen',
  'mfwNames.customTerm': 'Andere Laufzeit',
  'mfwNames.termRange': 'Gib eine ganze Zahl zwischen 1 und {max} Jahren ein.',
  'mfwNames.claimText':
    'Mit TEX8-Sendedienst und getrennten verfügbaren Coins bestätigst du gleich die zweite Transaktion. Der Dienst erfährt den Claim vorab und sendet ihn nach 15 Blöcken. Sonst bestätigst du Schritt 2 nach der Erinnerung.',
  'mfwNames.claimTitle': 'Namen registrieren und bezahlen',
  'mfwNames.claimBroadcastMessage':
    'Schritt 2 von 2 wurde gesendet. Der Name wird nach der Blockchain-Bestätigung aktiv.',
  'mfwNames.claimPendingBanner':
    'Die letzte Transaktion wurde gesendet. Die Blockchain-Bestätigung steht noch aus.',
  'mfwNames.claimReadyBanner':
    'Bestätige jetzt die letzte Transaktion. Im Claim-Fenster bleiben etwa {blocks} Blöcke.',
  'mfwNames.claimDeadlineHeight': 'Claim-Frist: Block {height}',
  'mfwNames.commitText':
    'Prüfe eine vorausgefüllte Commit-Transaktion. Sie verbirgt den Namen vor Beobachtern des Mempools.',
  'mfwNames.commitTitle': 'Namen vormerken',
  'mfwNames.commitBlocksBanner':
    'Schritt 2 wird in etwa {blocks} Block bzw. Blöcken möglich. Wir erinnern dich lokal.',
  'mfwNames.commitBroadcastMessage':
    'Schritt 1 von 2 wurde gesendet. Schritt 2 ist nach 15 Blöcken möglich; die App erinnert dich.',
  'mfwNames.commitWaitingBanner':
    'Der Commit wartet auf den ersten Block. Schritt 2 folgt normalerweise nach etwa 30 Minuten.',
  'mfwNames.availabilityLocalPending':
    'Schritt 1 ist auf diesem Gerät bereits ausstehend. Schließe Schritt 2 ab, statt erneut zu registrieren.',
  'mfwNames.localRegistrationPending':
    'Diese Registrierung läuft bereits. Fahre mit dem nächsten Schritt fort.',
  'mfwNames.maturityHeight': 'Schritt 2 möglich ab Block {height}',
  'mfwNames.confirmClaim': 'Registrierung bestätigen',
  'mfwNames.confirmCommit': 'Commit bestätigen',
  'mfwNames.approvalExpiresIn':
    'Die Transaktionsfreigabe läuft in {seconds} s ab.',
  'mfwNames.approvalExpired':
    'Die Transaktionsfreigabe ist abgelaufen. Bereite sie vor der Bestätigung erneut vor.',
  'mfwNames.prepareApprovalAgain': 'Freigabe erneut vorbereiten',
  'mfwNames.confirmRenew': 'Verlängerung bestätigen',
  'mfwNames.confirmRevoke': 'Widerruf bestätigen',
  'mfwNames.confirmUpdate': 'Adressänderung bestätigen',
  'mfwNames.continue': 'Erste Bestätigung vorbereiten',
  'mfwNames.createDedicated': 'Eigene Adresse erstellen',
  'mfwNames.createDedicatedHint':
    'Empfohlen: Verknüpfe den öffentlichen Namen nicht dauerhaft mit deiner Hauptadresse.',
  'mfwNames.currentAddress': 'Aktuelle öffentliche Adresse',
  'mfwNames.dedicated': 'Separat',
  'mfwNames.decryptRecovery': 'Nativen Recovery-Dialog öffnen',
  'mfwNames.daysRemaining': 'Tage verbleibend',
  'mfwNames.daysValue': '~{count} Tage',
  'mfwNames.expiredFreshClaim':
    'Dieser Name ist nicht mehr aktiv und muss mit einem neuen Commit und Claim erneut registriert werden.',
  'mfwNames.expiresAtBlock': 'Ablaufblock',
  'mfwNames.expiryEstimate':
    'Zeit- und Tagesangaben sind Schätzungen mit zwei Minuten je Block; maßgeblich ist der Ablaufblock.',
  'mfwNames.invalidName':
    'Verwende 1–63 Kleinbuchstaben, Zahlen oder Bindestriche innerhalb des Namens.',
  'mfwNames.registeredNames': 'Bereits registrierte Namen',
  'mfwNames.registeredNamesSubtitle':
    'Namen, die du bereits auf diesem Gerät registriert hast.',
  'mfwNames.myNames': 'Deine Namen',
  'mfwNames.showMore': 'Mehr anzeigen',
  'mfwNames.showLess': 'Weniger anzeigen',
  'mfwNames.newAddress': 'Neue öffentliche Adresse',
  'mfwNames.name': 'Adressname',
  'mfwNames.nameHint':
    'Die Endung .mfw wird automatisch ergänzt. Unicode-Lookalikes sind nicht zulässig.',
  'mfwNames.namePlaceholder': 'alice',
  'mfwNames.namesLoadFailed':
    'Deine lokal verwalteten Namen konnten nicht geladen werden.',
  'mfwNames.nativePreparationRequired':
    'Die native Vorbereitung der Namenstransaktion ist in diesem Build nicht aktiviert.',
  'mfwNames.networkFeesExtra':
    'Zwei normale Monero-Netzwerkgebühren kommen hinzu',
  'mfwNames.noAddress': 'Öffne diese Wallet einmal, um ihre Adressen zu laden.',
  'mfwNames.noNames': 'Noch keine lokal verwalteten .mfw-Namen.',
  'mfwNames.noWallet': 'Keine Wallet ausgewählt',
  'mfwNames.oneRenewalApproval':
    'Eine ausdrückliche Bestätigung ist erforderlich',
  'mfwNames.openSelectedWallet':
    'Öffne die ausgewählte Wallet, bevor du eine eigene Adresse erstellst.',
  'mfwNames.openWalletFirst': 'Öffne und synchronisiere zuerst eine Wallet.',
  'mfwNames.ownerKeySecurity':
    'Ein eigener Schlüssel für den Namensbesitz bleibt im geschützten nativen Gerätespeicher. Vor der Registrierung ist ein verschlüsseltes Recovery-Backup erforderlich.',
  'mfwNames.primaryAddress': 'Hauptadresse',
  'mfwNames.prepareRenewal': 'Verlängerung vorbereiten',
  'mfwNames.prepareUpdate': 'Adressänderung vorbereiten',
  'mfwNames.operation': 'Protokollaktion',
  'mfwNames.publicWarning':
    'Name und Empfangsadresse bleiben dauerhaft öffentlich in der Monero-Blockchain sichtbar. Mit der öffentlichen Adresse kann niemand Geld ausgeben oder dein Wallet-Guthaben sehen.',
  'mfwNames.registryPrice': 'Preis der Monero Fast Wallet Registry',
  'mfwNames.recoveryRequired':
    'Speichere die verschlüsselte Owner-Wiederherstellung, bevor du die Registrierung bestätigst.',
  'mfwNames.recoveryImported':
    'Owner-Recovery wiederhergestellt. Dieses Gerät kann den aktiven Namen jetzt verwalten.',
  'mfwNames.recoveryNativePrompt':
    'Das verschlüsselte Paket und das Passwort bleiben im geschützten nativen Dialog.',
  'mfwNames.registerAgain': 'Erneut registrieren',
  'mfwNames.removeExpiredTitle': 'Abgelaufenen Eintrag löschen?',
  'mfwNames.removeExpiredDescription':
    'Dies entfernt nur den abgelaufenen Eintrag von diesem Gerät. Die Blockchain wird nicht verändert.',
  'mfwNames.removeExpiredFailed':
    'Der abgelaufene Eintrag konnte nicht gelöscht werden.',
  'mfwNames.registeredTerm': 'Laufzeit',
  'mfwNames.renew': 'Verlängern',
  'mfwNames.renewDescription':
    'Wähle die zusätzliche Laufzeit. Die bestehende öffentliche Adresse bleibt erhalten; der geschützte Namensbesitz-Schlüssel muss die Verlängerung signieren.',
  'mfwNames.renewNetworkFeeExtra':
    'Eine normale Monero-Netzwerkgebühr kommt hinzu',
  'mfwNames.renewTitle': 'Namen verlängern',
  'mfwNames.renewTransactionText':
    'Prüfe eine vorausgefüllte, vom Besitzer signierte Transaktion, die den aktiven Eintrag verlängert.',
  'mfwNames.reviewSubtitle':
    'Ziel der Monero Fast Wallet Registry, Betrag und signierte Protokolldaten sind durch die native Wallet gesperrt. Prüfe sie und bestätige danach.',
  'mfwNames.reviewTitle': 'Namenstransaktion prüfen',
  'mfwNames.restoreRecovery': 'Owner-Recovery wiederherstellen',
  'mfwNames.restoreRecoveryDescription':
    'Gib zuerst den öffentlichen Namen ein. Die Wallet prüft seinen aktuellen Blockchain-Eintrag, bevor der native Recovery-Dialog etwas entschlüsselt.',
  'mfwNames.revoke': 'Widerrufen',
  'mfwNames.revokeTitle': 'Namen widerrufen',
  'mfwNames.selectedWallet': 'Ausgewählte Wallet: {wallet}',
  'mfwNames.subaddressLabel': 'Öffentlicher Name {name}',
  'mfwNames.subtitle':
    'Registriere einen leicht merkbaren öffentlichen .mfw-Namen für eine deiner Monero-Empfangsadressen.',
  'mfwNames.statusActive': 'Aktiv',
  'mfwNames.statusClaimPending': 'Claim ausstehend',
  'mfwNames.statusCommitPending': 'Commit ausstehend',
  'mfwNames.statusExpired': 'Abgelaufen',
  'mfwNames.statusFailed': 'Fehlgeschlagen',
  'mfwNames.statusRenewPending': 'Verlängerung ausstehend',
  'mfwNames.statusRevokePending': 'Widerruf ausstehend',
  'mfwNames.statusUpdatePending': 'Adressänderung ausstehend',
  'mfwNames.statusRevealReady': 'Bereit zum Claim',
  'mfwNames.statusClaimExpired': 'Claim-Zeitfenster abgelaufen',
  'mfwNames.claimExpiredDescription':
    'Schritt 2 wurde nicht innerhalb des Claim-Zeitfensters gesendet. Starte die Registrierung mit einem neuen Commit erneut.',
  'mfwNames.statusRevoked': 'Widerrufen',
  'mfwNames.stepOneComplete': 'Schritt 1 von 2 abgeschlossen',
  'mfwNames.stepOneSentDescription':
    'Die private Vormerkung wurde an die Blockchain gesendet.',
  'mfwNames.stepTwoReady': 'Schritt 2 von 2 ist bereit',
  'mfwNames.stepTwoReadyDescription':
    'Bestätige jetzt Claim und Registry-Zahlung. Es bleiben etwa {blocks} Blöcke.',
  'mfwNames.stepTwoSent': 'Schritt 2 von 2 gesendet',
  'mfwNames.stepTwoSentDescription':
    'Claim und Registry-Zahlung warten auf die Blockchain-Bestätigung.',
  'mfwNames.stepTwoScheduled': 'Beide Freigaben abgeschlossen',
  'mfwNames.relayUploading': 'Beide Transaktionen signiert. Verbindung zum Sendedienst wird hergestellt – App offen lassen, bis der Server den Empfang bestätigt.',
  'mfwNames.relayAccepted': 'Der Server hat Schritt 2 gespeichert und sendet ihn nach 15 Blöcken, auch bei geschlossener App. Für die Benachrichtigung müssen Mitteilungen aktiviert sein.',
  'mfwNames.relayCheckStatus': 'Beide Transaktionen signiert. Prüfe oben den Übertragungsstatus, bevor du die App schließt.',
  'mfwNames.relayTransmitting': 'Der Server überträgt Schritt 2. Die Bestätigung aus dem Netzwerk steht noch aus.',
  'mfwNames.relayCancel': 'Automatik stoppen · Schritt 2 selbst bestätigen',
  'mfwNames.relayCancelling': 'Abbruchbestätigung wird abgewartet…',
  'mfwNames.relayApproveSecond': 'Schritt 2 von 2: Bestätige jetzt Namen und Zahlung. Danach wird die Transaktion zum späteren Senden an den Server übergeben.',
  'mfwNames.relayManualFallback': 'Der automatische zweite Schritt war nicht verfügbar. Bestätige ihn hier, sobald der Commit bereit ist. Aktiviere Mitteilungen für eine Erinnerung; diese bestätigt noch nicht die Blockchain-Reife.',
  'mfwNames.stepTwoScheduledDescription':
    'Die letzte Transaktion liegt geschützt auf diesem Gerät und wird nach 15 Blöcken automatisch gesendet.',
  'mfwNames.notificationTitle': 'Monero Fast Wallet Name',
  'mfwNames.notificationCheckStepTwo':
    'Öffne die App und prüfe, ob Schritt 2 von 2 bereit ist.',
  'mfwNames.notificationStepTwoReady':
    'Schritt 2 von 2 ist bereit. Öffne die App und schließe die Namensregistrierung ab.',
  'mfwNames.term': 'Laufzeit',
  'mfwNames.termValue': '{count} Protokolljahr(e)',
  'mfwNames.title': 'Deine Adressnamen',
  'mfwNames.twoApprovals': 'Zwei ausdrückliche Bestätigungen sind erforderlich',
  'mfwNames.changeAddress': 'Adresse ändern',
  'mfwNames.chooseDifferentAddress':
    'Wähle eine andere als die aktuelle öffentliche Adresse.',
  'mfwNames.chooseNewAddress': 'Wähle die neue öffentliche Empfangsadresse.',
  'mfwNames.oneUpdateApproval':
    'Eine ausdrückliche Bestätigung ist erforderlich',
  'mfwNames.updateDescription':
    'Wähle die neue öffentliche Empfangsadresse. Der geschützte Namensbesitz-Schlüssel signiert die Änderung.',
  'mfwNames.updateNetworkCost':
    'Keine Gebühr der Monero Fast Wallet Registry für eine Adressänderung',
  'mfwNames.updateTitle': 'Öffentliche Adresse ändern',
  'mfwNames.updateTransactionText':
    'Prüfe eine vorausgefüllte, vom Besitzer signierte Transaktion, die die öffentliche Empfangsadresse ersetzt.',
  'mfwNames.unknownWallet': 'Unbekannte Wallet',
  'mfwNames.wallet': 'Wallet für diesen Namen',
  'mfwNames.walletNoLongerAvailable':
    'Die Wallet oder der aktuelle kanonische Status dieses Namens ist nicht verfügbar. Öffne und synchronisiere die ursprüngliche Wallet, bevor du fortfährst.',
  'mfwNames.year': 'Jahr',
  'mfwNames.years': 'Jahre',
  'privateContacts.title': 'Private Kontakte',
  'privateContacts.menuDescription':
    'Personen finden oder eine Empfangsadresse privat teilen',
  'privateContacts.subtitle':
    'Deine Kontakte bleiben auf diesem Gerät. Du bestimmst, wer was sehen darf.',
  'privateContacts.findTitle': 'Personen aus meinen Kontakten finden',
  'privateContacts.findDescription':
    'Die App prüft geschützte anonyme Codes direkt auf diesem Gerät. Namen und Telefonnummern werden nicht hochgeladen.',
  'privateContacts.findOn': 'Personen finden ist eingeschaltet',
  'privateContacts.findOff': 'Personen finden einschalten',
  'privateContacts.turnOff': 'Ausschalten',
  'privateContacts.verifyTitle': 'Deine Telefonnummer bestätigen',
  'privateContacts.verifyDescription':
    'Das zeigt nur, dass du einen Code unter dieser Nummer empfangen kannst. Deine Identität wird nicht geprüft.',
  'privateContacts.phonePlaceholder':
    'Internationale Nummer, zum Beispiel +507…',
  'privateContacts.sendCode': 'Code senden',
  'privateContacts.codePlaceholder': 'Bestätigungscode',
  'privateContacts.confirmCode': 'Code bestätigen',
  'privateContacts.verifiedUntil': 'Telefon bestätigt bis {date}',
  'privateContacts.shareTitle': 'Mit ausgewählten Kontakten teilen',
  'privateContacts.shareDescription':
    'Nichts wird automatisch geteilt. Wähle eine Person und eine einfache Option.',
  'privateContacts.manualName': 'Name (bleibt nur auf diesem Gerät)',
  'privateContacts.noContacts':
    'Erlaube oben den Kontaktzugriff oder gib eine Telefonnummer manuell ein.',
  'privateContacts.badge': 'Zeigen, dass ich Fast Wallet nutze',
  'privateContacts.badgeDescription': 'Es wird keine Empfangsadresse geteilt.',
  'privateContacts.ask': 'Vor dem Teilen fragen',
  'privateContacts.askDescription':
    'Die andere Person muss jedes Mal nach einer Empfangsadresse fragen.',
  'privateContacts.direct': 'Eine Empfangsadresse teilen',
  'privateContacts.directDescription':
    'Erstellt eine eigene öffentliche Empfangsadresse in deiner geöffneten Wallet. Kein privater Schlüssel wird geteilt.',
  'privateContacts.stopSharing': 'Nicht mehr teilen',
  'privateContacts.statusPublishing': 'Wird sicher gespeichert…',
  'privateContacts.statusActive': 'Geteilt',
  'privateContacts.statusRevoking': 'Wird entfernt…',
  'privateContacts.walletRequired':
    'Öffne zuerst die Wallet, deren Empfangsadresse du teilen möchtest.',
  'privateContacts.removeTitle': 'Meine Telefonnummer entfernen',
  'privateContacts.removeDescription':
    'Beendet alle Kontaktfreigaben und entfernt dieses Telefon aus dem privaten Verzeichnis.',
  'privateContacts.removeAction': 'Mein Telefon entfernen',
  'privateContacts.useTitle': 'An diese Person zahlen',
  'privateContacts.useDescription':
    'Prüfe privat, ob diese Person eine aktuelle Empfangsadresse mit dir geteilt hat.',
  'privateContacts.checkPerson': 'Diese Person prüfen',
  'privateContacts.lookupBadge':
    'Diese Person nutzt Fast Wallet, hat aber keine Empfangsadresse geteilt.',
  'privateContacts.lookupAsk':
    'Diese Person möchte jede Adressanfrage bestätigen. Noch wurde keine Adresse geteilt.',
  'privateContacts.requestAddress': 'Nach Adresse fragen',
  'privateContacts.outgoingTitle': 'Adressanfrage',
  'privateContacts.requestSent':
    'Deine private Anfrage wurde gesendet. Du kannst diese Seite verlassen und später nachsehen.',
  'privateContacts.requestAnswered':
    'Die Person hat auf deine Anfrage geantwortet.',
  'privateContacts.checkRequest': 'Antwort prüfen',
  'privateContacts.requestStillWaiting': 'Es gibt noch keine Antwort.',
  'privateContacts.requestDeclined': 'Die Person möchte keine Adresse teilen.',
  'privateContacts.requestExpired':
    'Diese Anfrage ist abgelaufen. Du kannst eine neue senden.',
  'privateContacts.incomingTitle': 'Jemand fragt nach einer Adresse',
  'privateContacts.incomingDescription':
    'Teile sie nur mit Personen, die du kennst. Für jede Zustimmung wird eine neue Empfangsadresse erstellt.',
  'privateContacts.requestExpires': 'Bitte bis {time} antworten',
  'privateContacts.declineRequest': 'Nicht teilen',
  'privateContacts.approveRequest': 'Neue Adresse teilen',
  'privateContacts.approveRequestConfirm':
    'Eine neue Empfangsadresse mit dieser Person teilen? Damit kann niemand dein Geld ausgeben.',
  'privateContacts.lookupUnavailable':
    'Keine aktuelle Empfangsadresse ist verfügbar. Die Person kann auch offline sein oder nichts teilen wollen.',
  'privateContacts.walletRequiredForSending':
    'Öffne zuerst die Wallet, von der du senden möchtest.',
  'menu.addressBook': 'Adressbuch',
  'menu.addressBookDesc': 'Gespeicherte Adressen',
  'menu.configureWallet': 'Wallet konfigurieren',
  'menu.connectionStatus': 'Verbindungsstatus',
  'menu.export': 'Export',
  'menu.exportDesc': 'Transaktionen exportieren',
  'menu.footer': 'Made with ❤️ by TEX8',
  'menu.footerAccessibility': 'Mit Liebe von TEX8 entwickelt',
  'menu.footerPrefix': 'Entwickelt mit',
  'menu.footerBy': 'von',
  'menu.help': 'Hilfe',
  'menu.helpDesc': 'FAQ & Support',
  'menu.locked': 'Gesperrt',
  'menu.myWallet': 'Meine Wallet',
  'menu.noWalletOpen': 'Keine Wallet geöffnet',
  'menu.nodeStatus': 'Node-Status',
  'nodeStatus.subtitle':
    'Zwei globale Wege: schnelle Block-Synchronisierung über Clearnet und alle anderen Wallet-Vorgänge über Tor.',
  'nodeStatus.diagnostics': 'Verbindung prüfen',
  'nodeStatus.diagnosticsHint':
    'Prüft Tor für Wallet-Vorgänge und Clearnet für den schnellen Blockchain-Sync getrennt.',
  'nodeStatus.globalRoutes': 'Globale Node-Routen',
  'nodeStatus.globalRoutesHint':
    'Diese Wege gelten für alle Wallets auf diesem Gerät. Jede Änderung wird automatisch gespeichert.',
  'nodeStatus.torRoute': 'Tor-Verbindung',
  'nodeStatus.torHint':
    'Wallet-Vorgänge und private Dienste verwenden den gewählten Daemon über integriertes Tor.',
  'nodeStatus.clearnetRoute': 'Clearnet Block-Sync',
  'nodeStatus.clearnetHint':
    'Nur öffentliche Blockchain-Blöcke verwenden die schnelle Clearnet-gRPC-Route.',
  'nodeStatus.connected': 'Verbunden',
  'nodeStatus.notConnected': 'Fehler',
  'nodeStatus.checking': 'Wird geprüft',
  'nodeStatus.autoSaved': 'Automatisch gespeichert',
  'nodeStatus.autoSaving': 'Wird gespeichert…',
  'nodeStatus.autoSaveError': 'Eingaben prüfen',
  'nodeStatus.syncStorage': 'Sync-Speicher',
  'nodeStatus.syncStorageHint':
    'Temporäre öffentliche Blöcke werden nach dem Scannen gelöscht. Ein kleineres Limit kann den ersten Sync verlangsamen.',
  'nodeStatus.syncStorageRestart':
    'Gespeichert. Starte die App vor dem nächsten Sync neu.',
  'menu.sharedAiModule': 'Tex8-Assistent',
  'assistant.kicker': 'Tex8 Shared',
  'assistant.title': 'KI-Assistent',
  'assistant.placeholder': 'Frage nach Wallet-Funktionen…',
  'settings.appearance': 'Darstellung',
  'settings.autoLock': 'Auto-Sperre (5 Min.)',
  'settings.lockAfterInactivity': 'Nach Inaktivität sperren',
  'settings.timeout1Minute': '1 Min.',
  'settings.timeout5Minutes': '5 Min.',
  'settings.timeout15Minutes': '15 Min.',
  'settings.timeout30Minutes': '30 Min.',
  'settings.timeout1Hour': '1 Stunde',
  'settings.timeoutNever': 'Nie',
  'settings.appProtection': 'App-Schutz',
  'settings.appProtectionHint':
    'Wähle, wie die App entsperrt wird: mit Biometrie oder einem App-Passwort. Das schützt alle gespeicherten Wallets.',
  'settings.noProtection': 'Kein Schutz',
  'settings.noProtectionActive':
    'Derzeit ist kein App-Schutz aktiv. Wähle unten eine Methode, um ihn zu aktivieren.',
  'settings.biometrics': 'Biometrie',
  'settings.appPassword': 'App-Passwort',
  'settings.setAppPassword': 'App-Passwort festlegen',
  'settings.confirmAppPassword': 'App-Passwort bestätigen',
  'settings.saveAppProtection': 'Schutz speichern',
  'settings.appProtectionSaved': 'App-Schutz gespeichert.',
  'settings.appProtectionFailed':
    'Der App-Schutz konnte nicht geändert werden. Es wurde nichts verändert.',
  'settings.changeWalletPassword': 'Wallet-Passwort ändern',
  'settings.confirmWalletPassword': 'Neues Passwort bestätigen',
  'settings.createIdentity': 'Identität erstellen',
  'settings.currencyUsd': 'Währung: USD',
  'settings.daemonTls': 'Daemon TLS',
  'settings.default': 'Standard',
  'settings.diagnostics': 'Diagnose',
  'settings.diagnosticRunFailed':
    'Die Diagnose konnte nicht abgeschlossen werden. Der technische Fehler wurde im App-Log gespeichert.',
  'settings.diagnosticPassed': 'Bestanden',
  'settings.diagnosticWarnings': 'Warnungen',
  'settings.diagnosticFailed': 'Fehlgeschlagen',
  'settings.diagnosticSkipped': 'Übersprungen',
  'settings.diagnosticTotal': 'Gesamte Testdauer: {duration} ms',
  'action.skip': 'Überspringen',
  'security.skipProtectionHint':
    'Diese Auswahl wird gespeichert. Du kannst den App-Schutz später in den Einstellungen aktivieren.',
  'diagnostic.category.core': 'Core',
  'diagnostic.category.security': 'Sicherheit',
  'diagnostic.category.network': 'Netzwerk',
  'diagnostic.category.performance': 'Leistung',
  'diagnostic.category.wallet': 'Wallet',
  'diagnostic.category.fastWallet': 'Fast Wallet',
  'diagnostic.category.hardware': 'Hardware',
  'diagnostic.test.nativeCore': 'Nativer Monero-Core',
  'diagnostic.test.secureStorage': 'Test des geschützten Speichers',
  'diagnostic.test.nodeConfiguration': 'Node-Konfiguration',
  'diagnostic.test.sharedConnection': 'Gemeinsame Blockchain-Verbindung',
  'diagnostic.test.scanPack': 'gRPC-/ScanPack-Pfad',
  'diagnostic.test.throughput': 'Block-Download-Durchsatz',
  'diagnostic.test.walletSnapshot': 'Wallet-Snapshot',
  'diagnostic.test.multiWallet': 'Verteilung an mehrere Wallets',
  'diagnostic.test.fastWalletIntegrity': 'Lokale Integrität der Fast Wallet',
  'diagnostic.test.fastWalletHosting': 'Verschlüsseltes Fast Wallet-Hosting',
  'diagnostic.test.derivationEngine': 'Schlüsselableitungs-Engine',
  'diagnostic.test.ledgerTransport': 'Ledger-Verbindung',
  'diagnostic.metric.backend': 'Backend',
  'diagnostic.metric.productCoreAbi': 'Product-Core-ABI',
  'diagnostic.metric.productCoreSchema': 'Product-Core-Schema',
  'diagnostic.metric.schema': 'Schema',
  'diagnostic.metric.registry': 'Diagnoseregister',
  'diagnostic.metric.appVaultSchema': 'AppVault-Statusschema',
  'diagnostic.metric.mode': 'Modus',
  'diagnostic.metric.network': 'Netzwerk',
  'diagnostic.metric.state': 'Status',
  'diagnostic.metric.phase': 'Phase',
  'diagnostic.metric.chainHeight': 'Blockchain-Höhe',
  'diagnostic.metric.targetHeight': 'Zielhöhe',
  'diagnostic.metric.transportStarts': 'Verbindungsstarts',
  'diagnostic.metric.providerGeneration': 'Anbietergeneration',
  'diagnostic.metric.batches': 'Pakete',
  'diagnostic.metric.blocks': 'Blöcke',
  'diagnostic.metric.decoded': 'Dekodiert',
  'diagnostic.metric.networkThroughput': 'Netzwerkdurchsatz',
  'diagnostic.metric.payloadThroughput': 'Nutzdatendurchsatz',
  'diagnostic.metric.blockThroughput': 'Blockdurchsatz',
  'diagnostic.metric.networkSample': 'Netzwerkstichprobe',
  'diagnostic.metric.payloadSample': 'Nutzdatenstichprobe',
  'diagnostic.metric.fetchTime': 'Abrufzeit',
  'diagnostic.metric.walletHeight': 'Wallet-Höhe',
  'diagnostic.metric.daemonHeight': 'Daemon-Höhe',
  'diagnostic.metric.synchronized': 'Synchronisiert',
  'diagnostic.metric.registeredWallets': 'Registrierte Wallets',
  'diagnostic.metric.joinedWallets': 'Verbundene Wallets',
  'diagnostic.metric.scanWorkers': 'Scan-Worker',
  'diagnostic.metric.stalledWallets': 'Stockende Wallets',
  'diagnostic.metric.deliveries': 'Zustellungen',
  'diagnostic.metric.fastWallets': 'Fast Wallets',
  'diagnostic.metric.hosted': 'Gehostet',
  'diagnostic.metric.missingCredentials': 'Fehlende Zugangsdaten',
  'diagnostic.metric.missingRegistrations': 'Fehlende Registrierungen',
  'diagnostic.metric.invalidAssignments': 'Ungültige Zuordnungen',
  'diagnostic.metric.officialWorker': 'Offizieller Worker',
  'diagnostic.metric.privateWorker': 'Privater Worker',
  'diagnostic.metric.invalid': 'Ungültig',
  'diagnostic.metric.hostedAssignments': 'Gehostete Zuordnungen',
  'diagnostic.metric.verifiedWorkers': 'Geprüfte Worker',
  'diagnostic.metric.cpuWorkers': 'CPU-Worker',
  'diagnostic.metric.transport': 'Verbindung',
  'diagnostic.metric.devices': 'Geräte',
  'diagnostic.value.configured': 'Eingerichtet',
  'diagnostic.value.disabled': 'Deaktiviert',
  'diagnostic.value.yes': 'Ja',
  'diagnostic.value.no': 'Nein',
  'diagnostic.value.none': 'Keine',
  'diagnostic.value.unknown': 'Unbekannt',
  'diagnostic.summary.coreReady':
    'Der mitgelieferte Monero-Wallet-Core ist verbunden und ansprechbar.',
  'diagnostic.summary.coreMissing': 'Der native Monero-Wallet-Core fehlt.',
  'diagnostic.summary.secureStorageReady':
    'Temporäre geschützte Zugangsdaten wurden gespeichert, gelesen und gelöscht.',
  'diagnostic.summary.secureStorageFailed':
    'Der geschützte Speicher lieferte die temporären Zugangsdaten nicht zurück.',
  'diagnostic.summary.nodeOptimized':
    'Die gRPC- und Daemon-Endpunkte von Monero Fast Node sind eingerichtet.',
  'diagnostic.summary.nodeOriginal':
    'Die originale Monero-RPC-Verbindung ist eingerichtet.',
  'diagnostic.summary.nodeIncomplete':
    'Das aktive Node-Profil ist unvollständig.',
  'diagnostic.summary.openWalletForNetwork':
    'Öffne mindestens eine Wallet, um die gemeinsame Node-Verbindung zu testen.',
  'diagnostic.summary.sharedState':
    'Die gemeinsame Verbindung hat den Status {state}.',
  'diagnostic.summary.sharedReady':
    'Eine gemeinsame Verbindung versorgt alle geöffneten Wallets.',
  'diagnostic.summary.sharedPending':
    'Die erste gemeinsame Node-Verbindung steht noch aus.',
  'diagnostic.summary.originalPath':
    'Das aktive Profil verwendet bewusst die originale Monero-RPC-Verbindung.',
  'diagnostic.summary.scanPackPending':
    'gRPC ist eingerichtet, aber es ist noch kein authentifiziertes Blockpaket eingetroffen.',
  'diagnostic.summary.scanPackReady':
    'Der optimierte Transport lieferte dekodierte gemeinsame Blockpakete.',
  'diagnostic.summary.noThroughput':
    'In dieser App-Sitzung wurde noch kein nicht leeres Blockpaket geladen.',
  'diagnostic.summary.throughputReady':
    'Direkt am Transport des Monero-Nodes gemessen.',
  'diagnostic.summary.throughputSmall':
    'Gemessen, aber das letzte Paket ist für eine stabile Kapazitätsschätzung zu klein.',
  'diagnostic.summary.openWalletForSnapshot':
    'Öffne eine Wallet, um ihren lokalen Core-Snapshot zu testen.',
  'diagnostic.summary.snapshotReady':
    'Die aktive Wallet lieferte einen konsistenten lokalen Core-Snapshot.',
  'diagnostic.summary.snapshotInvalid':
    'Die Wallet-Höhe stimmt nicht mit dem authentifizierten Blockchain-Ziel überein.',
  'diagnostic.summary.noJoinedWallet':
    'Der gemeinsamen Synchronisierung ist derzeit keine Wallet beigetreten.',
  'diagnostic.summary.walletStalled': 'Mindestens ein Wallet-Scanner stockt.',
  'diagnostic.summary.fanoutReady':
    'Heruntergeladene Pakete werden an alle verbundenen Wallet-Scanner verteilt.',
  'diagnostic.summary.noFastWallet': 'Es ist keine Fast Wallet eingerichtet.',
  'diagnostic.summary.fastWalletReady':
    'Jede Fast Wallet besitzt geschützte lokale Zugangsdaten und konsistente Registrierungsdaten.',
  'diagnostic.summary.fastWalletInvalid':
    'Fast Wallet-Registrierung oder geschützte Zugangsdaten sind unvollständig.',
  'diagnostic.summary.noHostedFastWallet':
    'Keine Fast Wallet besitzt derzeit gehostete verschlüsselte Scandaten.',
  'diagnostic.summary.hostingReady':
    'Jede geschützte Worker-Zuordnung wurde geprüft, ohne sie zu verändern.',
  'diagnostic.summary.hostingInvalid':
    'Mindestens eine verschlüsselte Zuordnung ist unvollständig oder abgelaufen.',
  'diagnostic.summary.engineReady':
    'Die mitgelieferte Engine hat den begrenzten Benchmark mit öffentlichen Testvektoren bestanden.',
  'diagnostic.summary.engineInvalid':
    'Das CPU-Backend für Schlüsselableitungen lieferte kein bestätigtes Ergebnis.',
  'diagnostic.summary.ledgerUnsupported':
    'Ledger wird auf dieser Plattform nicht unterstützt.',
  'diagnostic.summary.ledgerMissing':
    'Kein Ledger ist verbunden; es wurde keine Berechtigungsabfrage geöffnet.',
  'diagnostic.summary.ledgerReady': 'Die Ledger-Verbindung ist verfügbar.',
  'diagnostic.summary.ledgerPermission':
    'Ledger ist sichtbar, benötigt aber eine Verbindungsberechtigung.',
  'settings.testNotificationTitle': 'Testbenachrichtigung',
  'settings.testNotificationFailed':
    'Die Testbenachrichtigung konnte nicht gesendet werden. Der technische Fehler wurde im App-Log gespeichert.',
  'settings.testNotificationSentTitle': 'Testbenachrichtigung gesendet',
  'settings.testNotificationSentBody':
    'FCM-Token erstellt ({count} Zeichen), App Check und Gateway-Registrierung akzeptiert. Firebase hat eine allgemeine Testbenachrichtigung für dieses Telefon angenommen. Sie enthält keine Wallet- oder Transaktionsdaten.',
  'settings.sendingTestNotification': 'Test wird gesendet…',
  'settings.sendTestNotification': 'Testbenachrichtigung senden',
  'settings.ledgerBalanceVerification': 'Ledger-Guthaben prüfen',
  'settings.ledgerBalanceVerificationHint':
    'Key Images manuell erneut prüfen, wenn dieser Ledger auf einem anderen Gerät verwendet wurde.',
  'settings.ledgerBalanceVerifying': 'Prüfung mit Ledger…',
  'settings.ledgerBalanceVerified':
    'Der vom Ledger signierte Ausgabestatus wurde geprüft und das lokale Guthaben aktualisiert.',
  'settings.ledgerBalanceFailed':
    'Das Ledger-Guthaben konnte nicht geprüft werden. Der technische Fehler wurde im App-Log gespeichert.',
  'settings.disabled': 'Deaktiviert',
  'settings.enableBiometrics': 'Biometrie aktivieren',
  'settings.fastReceive': 'Fast Wallet',
  'settings.info': 'Info',
  'settings.language': 'Sprache',
  'settings.languageCurrent': 'Sprache: {language}',
  'settings.languageSubtitle': 'Wähle die Sprache der App.',
  'settings.version': 'Version {version}',
  'settings.scanPerformance': 'Scan-Leistung',
  'settings.scanPerformanceHint':
    'Ein kurzer, einmaliger Gerätetest mit öffentlichen Beispieldaten. Dabei wird keine Wallet geöffnet und kein Wallet-Schlüssel verwendet.',
  'settings.performanceTestbenchHint':
    'Manueller Testbench mit öffentlichen Beispieldaten. Jedes unterstützte Backend läuft nacheinander genau 10 Sekunden. Dabei wird keine Wallet geöffnet und kein Wallet-Schlüssel verwendet.',
  'settings.runPerformanceTestbench': 'Performance-Testbench starten',
  'settings.performanceTestbenchRunning':
    'Testbench läuft · verfügbare Backends werden gemessen…',
  'settings.performanceMeasureFailed':
    'Der Performance-Testbench konnte nicht abgeschlossen werden.',
  'settings.performanceMeasuring': 'Wird einmalig gemessen…',
  'settings.performanceMeasuringShort': 'Wird gemessen…',
  'settings.performanceMeasured': 'Gemessen',
  'settings.performanceNotMeasured': 'Nicht gemessen',
  'settings.performanceUnavailable': 'Nicht verfügbar',
  'settings.cpuNeonBackend': 'CPU · NEON',
  'settings.performanceBackendProgress': '{backend} · {current}/{total}',
  'settings.performanceSeconds': '{elapsed} / {duration} s',
  'settings.performanceOverallProgress': 'Gesamt {progress}%',
  'settings.derivationsPerSecond': '{rate} Ableitungen/s',
  'settings.loading': 'Lädt',
  'settings.mode': 'Modus',
  'settings.node': 'Node',
  'settings.network': 'Netzwerk',
  'settings.nodeModeOriginal': 'Original Node',
  'settings.nodeModeTex8': 'Tex8 Node',
  'settings.nodeModeCustom': 'Eigene',
  'settings.availableNodeAddresses': 'Getrennte Node-Routen',
  'settings.availableNodeAddressesHelp':
    'Wähle beide Routen unabhängig: Blockchain-Blöcke synchronisieren über Clearnet-gRPC; alle anderen Daemon-Anfragen laufen über die gewählte Onion-Adresse und Tor unter 127.0.0.1:9050.',
  'settings.clearnetSyncRoute': 'Blockchain-Sync · Clearnet',
  'settings.onionDaemonRoute': 'Wallet-Vorgänge · Tor',
  'settings.clearnetGrpcEndpoint': 'Blockchain-Sync · Clearnet-gRPC',
  'settings.onionDaemonEndpoint': 'Wallet-Vorgänge · Tor-Daemon',
  'settings.tex8Node': 'TEX8-Node',
  'settings.communityNode': 'Community-Node',
  'settings.clearnetAddress': 'Clearnet',
  'settings.onionAddress': 'Onion',
  'settings.worker': 'Fast Wallet Worker',
  'settings.workerSubtitle':
    'Wähle, wer die zusätzliche Fast Wallet auf eingehende Zahlungen prüft. Spending Keys verlassen deine Wallet nie.',
  'settings.recommendedWorker': 'Empfohlen',
  'settings.recommendedWorkerHint':
    'Den in dieser App festgelegten, signierten TEX8-Worker verwenden.',
  'settings.communityWorkers': 'Bestätigte Community Worker',
  'settings.communityWorker': 'Community Worker',
  'settings.communityWorkerHint':
    'Es erscheinen nur Worker aus dem bestätigten öffentlichen Verzeichnis. Die App prüft die Zulassung nativ.',
  'settings.workerLoading': 'Lädt…',
  'settings.workerUnavailable':
    'Das Worker-Verzeichnis ist vorübergehend nicht erreichbar. Deine bisherige Auswahl bleibt aktiv.',
  'settings.privateWorker': 'Privater Worker',
  'settings.privateWorkerHint':
    'Erweitert: eigenen Worker mit seinem signierten QR-Code oder Descriptor verbinden.',
  'settings.privateWorkerPlaceholder':
    'Worker-QR-Text oder Descriptor einfügen',
  'settings.useWorker': 'Diesen Worker verwenden',
  'settings.mfwRegistry': 'Monero Name Registry',
  'settings.mfwRegistryHint':
    'Einen einfachen öffentlichen .mfw-Namen für eine Empfangsadresse registrieren und verwalten.',
  'settings.projectPage': 'Projektseite',
  'settings.projectPageHint':
    'Offizielle Clearnet- und Onion-Adressen, Dienste und eigener Betrieb.',
  'projectPage.eyebrow': 'Offenes Projekt',
  'projectPage.title': 'Projektseite & Dienste',
  'projectPage.subtitle':
    'Sieh dir Monero Fast Wallet, die öffentlichen Dienste und die Open-Source-Bausteine dahinter an.',
  'projectPage.addresses': 'Offizielle Adressen',
  'projectPage.addressesHint':
    'Dieselbe Projektseite ist über die offiziellen und unabhängigen Community-Routen erreichbar.',
  'projectPage.clearnet': 'Clearnet',
  'projectPage.onion': 'Onion',
  'projectPage.copy': 'Kopieren',
  'projectPage.copied': 'Kopiert',
  'projectPage.open': 'Öffnen',
  'projectPage.onionHint':
    'Onion-Links benötigen einen Tor-fähigen Browser. Beim Öffnen eines Links verlässt du die Wallet-App.',
  'projectPage.selfHosting': 'Selbst betreiben',
  'projectPage.ownNodeTitle': 'Deine eigene Monero Fast Node',
  'projectPage.ownNodeText':
    'Du kannst eine eigene Node betreiben und ihre Clearnet-gRPC- und Onion-Daemon-Routen unter Node-Status eintragen. Die App hält Block-Sync und privaten Wallet-Verkehr getrennt.',
  'projectPage.ownWorkerTitle': 'Dein eigener Fast Wallet Worker',
  'projectPage.ownWorkerText':
    'Du kannst einen privaten Worker betreiben und seinen signierten Descriptor unter Einstellungen → Fast Wallet Worker verbinden. Spending Keys verlassen deine Wallet nie.',
  'projectPage.services': 'Dienste',
  'projectPage.servicesHint':
    'Kurze Erklärungen und technische Details findest du auf der Projektseite.',
  'projectPage.serviceWallet': 'Monero Fast Wallet',
  'projectPage.serviceNode': 'Monero Fast Node',
  'projectPage.serviceRelay': 'Relay Service',
  'projectPage.serviceWorker': 'Fast Wallet Worker',
  'projectPage.serviceRegistry': 'Monero Name Registry',
  'projectPage.serviceAll': 'Alle Dienste',
  'projectPage.sourceCode': 'Quellcode',
  'settings.grpcEndpoint': 'gRPC-Endpunkt',
  'settings.originalNodeAddress': 'Original-Node-Adresse',
  'settings.originalNodeHelp':
    'Normale Monero-Node verwenden. Die automatische Fast Wallet-Erkennung ist in diesem Modus nicht verfügbar.',
  'settings.customNodeHelp':
    'Eigenen Daemon, optionalen MFN-gRPC-Endpunkt und optionalen lokalen Proxy verwenden.',
  'settings.openSourceLicenses': 'Open-Source-Lizenzen',
  'settings.openWalletFirst': 'Wallet zuerst öffnen',
  'settings.password': 'Passwort',
  'settings.passwordChangeHint':
    'Das neue Passwort bleibt nur im sicheren Speicher dieses Geräts.',
  'settings.passwordChanged': 'Wallet-Passwort geändert.',
  'settings.passwordHardware':
    'Ein Ledger-Passwort wird direkt auf dem Ledger verwaltet.',
  'settings.passwordMinimum': 'Verwende mindestens 12 Zeichen.',
  'settings.passwordMismatch': 'Die neuen Passwörter stimmen nicht überein.',
  'settings.privacyPolicy': 'Datenschutzrichtlinie',
  'settings.proxy': 'Proxy',
  'settings.ready': 'Bereit',
  'settings.saved': 'Gespeichert',
  'settings.secureStored': 'Sicher gespeichert',
  'settings.security': 'Sicherheit',
  'settings.showBackupSeed': 'Backup-Seed anzeigen',
  'settings.recoverySeedDescription':
    'Nur anzeigen, während diese Software-Wallet geöffnet ist.',
  'settings.recoverySeedError':
    'Der Wiederherstellungs-Seed konnte nicht gelesen werden.',
  'settings.recoverySeedHardware':
    'Der Ledger-Wiederherstellungs-Seed kann nur auf dem Ledger-Gerät angezeigt werden.',
  'settings.recoverySeedTitle': 'Wiederherstellungs-Seed',
  'settings.recoverySeedUnavailable': 'Öffne zuerst eine Software-Wallet.',
  'settings.recoverySeedWarning':
    'Schreibe diese Wörter offline auf. Teile sie niemals mit anderen.',
  'settings.softwareWalletRequired': 'Software-Wallet erforderlich',
  'settings.storedSecureStorage': 'Im sicheren Gerätespeicher abgelegt',
  'settings.fastWalletServerAddress': 'Fast Wallet-Server',
  'settings.tex8NodeHelp':
    'Getrennte optimierte Routen verwenden: schneller Blockchain-Sync über Clearnet und der übrige Daemon-Verkehr über Onion.',
  'settings.title': 'Einstellungen',
  'settings.trustedDaemon': 'Vertrauenswürdiger Daemon',
  'settings.unsaved': 'Ungespeichert',
  'settings.useTor': 'Tor verwenden',
  'settings.username': 'Benutzername',
  'settings.wallet': 'Wallet',
  'settings.walletPassword': 'Wallet-Passwort',
  'settings.newWalletPassword': 'Neues Wallet-Passwort',
  'status.applied': 'Angewendet',
  'status.creating': 'Wird erstellt',
  'status.error': 'Fehler',
  'status.failed': 'Fehlgeschlagen',
  'status.live': 'Live',
  'status.locked': 'Gesperrt',
  'status.missing': 'Fehlt',
  'status.none': 'Keine',
  'status.pending': 'Ausstehend',
  'status.ready': 'Bereit',
  'status.running': 'Läuft',
  'status.saved': 'Gespeichert',
  'status.setup': 'Setup',
  'status.unconfirmed': 'Unbestätigt',
  'status.warnings': 'Warnungen',
  'wallets.createFastWallet': 'Fast Wallet erstellen',
  'wallets.backup': 'Sichern',
  'wallets.backupRecoveryWords': 'Wiederherstellungswörter sichern',
  'wallets.receiveQuickly': 'Schnell empfangen',
  'wallets.walletNamePlaceholder': 'Wallet-Name',
  'wallets.fastWalletOriginalDisabled':
    'Wechsle zu Tex8 Node für die automatische Fast Wallet-Erkennung.',
  'wallets.fastWalletTex8Only':
    'Fast Wallets sind eigene Wallets. Der Server erkennt Eingänge; Spend Keys bleiben auf diesem Gerät.',
  'wallets.fastWallets': 'Fast Wallets',
  'wallets.manage': 'Wallets verwalten',
  'wallets.noFastWallets': 'Noch keine Fast Wallet.',
  'wallets.noWallets': 'Noch keine private Wallet.',
  'wallets.openFailedTitle': 'Wallet konnte nicht geöffnet werden',
  'wallets.openFailed': 'Die lokale Wallet konnte nicht geöffnet werden.',
  'wallets.privateWallets': 'Private Wallets',
  'wallets.removeFastWallet': 'Fast Wallet entfernen',
  'wallets.removeFastWalletConfirm':
    '{name} entfernen? Der automatische Server-Scan wird ebenfalls deaktiviert.',
  'wallets.removeFromApp': 'Aus App entfernen',
  'wallets.removeBackupTitle': 'Zuerst Wiederherstellungswörter sichern',
  'wallets.removeBackupDescription':
    'Bevor du {name} entfernst, schreibe die 25 Wiederherstellungswörter auf und bestätige sie. Danach kann die Wallet aus dieser App entfernt werden.',
  'wallets.removeWallet': 'Wallet entfernen',
  'wallets.removeWalletConfirm':
    'Die lokalen Daten von {name} endgültig entfernen? Ohne Wiederherstellungswörter oder Ledger kann der Zugriff nicht wiederhergestellt werden.',
  'wallets.removeFailedTitle': 'Wallet konnte nicht entfernt werden',
  'wallets.removeFailed':
    'Die lokalen Wallet-Daten konnten nicht entfernt werden.',
  'wallets.subtitle':
    'Private Wallets und Fast Wallets hinzufügen, wechseln und entfernen.',
  'wallets.title': 'Wallets',
};

export type LanguageCode = ProductLanguageCode;
export type TranslationKey = keyof typeof en;
export type ActiveTranslationCatalog = Record<TranslationKey, string>;

export function getBaseTranslationCatalog(
  language: LanguageCode,
): ActiveTranslationCatalog | undefined {
  if (language === 'en') return en;
  if (language === 'de') return de;
  return undefined;
}

export function getTranslation(
  language: LanguageCode,
  key: TranslationKey,
  activeCatalog?: ActiveTranslationCatalog,
): string {
  return (
    getBaseTranslationCatalog(language)?.[key] ??
    activeCatalog?.[key] ??
    en[key]
  );
}

export async function loadTranslationCatalog(
  language: LanguageCode,
): Promise<ActiveTranslationCatalog> {
  const baseCatalog = getBaseTranslationCatalog(language);
  if (baseCatalog) return baseCatalog;

  const loaders = generatedRuntimeCatalogLoaders as Partial<
    Record<LanguageCode, () => Promise<GeneratedRuntimeCatalog>>
  >;
  const catalog = await loaders[language]?.();
  return (catalog as ActiveTranslationCatalog | undefined) ?? en;
}

export const supportedLanguages: LanguageCode[] = productLanguageCodes;

export const languageNames = Object.fromEntries(
  supportedLanguages.map(code => [code, productLocaleByCode[code].nativeName]),
) as Record<LanguageCode, string>;

export const languageFlags = Object.fromEntries(
  supportedLanguages.map(code => [code, productLocaleByCode[code].flag]),
) as Record<LanguageCode, string>;

export const languageDateLocales = Object.fromEntries(
  supportedLanguages.map(code => [code, productLocaleByCode[code].tag]),
) as Record<LanguageCode, string>;

export const generatedLocaleMetadata = productLocaleByCode;

export function isLanguageCode(value: unknown): value is LanguageCode {
  return (
    typeof value === 'string' &&
    supportedLanguages.includes(value as LanguageCode)
  );
}
