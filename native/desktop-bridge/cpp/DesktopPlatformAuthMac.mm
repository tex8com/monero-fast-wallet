#include "DesktopPlatformAuth.h"

#if defined(__APPLE__)

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>

#include <cstring>

extern "C" int tex8_desktop_system_auth_available() noexcept {
  @autoreleasepool {
    LAContext* context = [LAContext new];
    NSError* error = nil;
    // Only offer this option when biometric hardware is enrolled. The actual
    // authorization below deliberately permits the Mac login password as the
    // operating-system fallback.
    return [context canEvaluatePolicy:LAPolicyDeviceOwnerAuthenticationWithBiometrics
                                error:&error]
               ? 1
               : 0;
  }
}

extern "C" int tex8_desktop_system_authenticate(
    const char* reason,
    void* /* parent_window */) noexcept {
  @autoreleasepool {
    LAContext* context = [LAContext new];
    NSString* prompt = reason != nullptr
                           ? [NSString stringWithUTF8String:reason]
                           : @"Unlock Monero Fast Wallet";
    if (prompt == nil || prompt.length == 0) {
      prompt = @"Unlock Monero Fast Wallet";
    }

    NSError* availabilityError = nil;
    if (![context canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication
                              error:&availabilityError]) {
      return 0;
    }

    dispatch_semaphore_t finished = dispatch_semaphore_create(0);
    __block BOOL accepted = NO;
    [context evaluatePolicy:LAPolicyDeviceOwnerAuthentication
            localizedReason:prompt
                      reply:^(BOOL success, NSError* _Nullable error) {
                        accepted = success && error == nil;
                        dispatch_semaphore_signal(finished);
                      }];
    const long waitResult = dispatch_semaphore_wait(
        finished,
        dispatch_time(DISPATCH_TIME_NOW, 120LL * NSEC_PER_SEC));
    if (waitResult != 0) {
      [context invalidate];
      return 0;
    }
    return accepted ? 1 : 0;
  }
}

extern "C" int tex8_desktop_prompt_recovery_seed(
    char* output,
    size_t output_length,
    void* /* parent_window */) noexcept {
  if (output == nullptr || output_length < 2) {
    return 0;
  }
  output[0] = '\0';

  @autoreleasepool {
    __block int result = 0;
    void (^presentPrompt)(void) = ^{
      const BOOL german =
          [[NSLocale preferredLanguages].firstObject hasPrefix:@"de"];
      NSString* title =
          german ? @"Wallet wiederherstellen" : @"Restore wallet";
      NSString* detail = german
          ? @"Gib deine 25 Wiederherstellungswörter ein. Sie bleiben auf diesem Gerät."
          : @"Enter your 25 recovery words. They stay on this device.";
      NSString* restore = german ? @"Wiederherstellen" : @"Restore";
      NSString* cancel = german ? @"Abbrechen" : @"Cancel";
      NSString* wordsLabel =
          german ? @"25 Wiederherstellungswörter" : @"25 recovery words";
      NSString* incompleteTitle = german
          ? @"Die Wiederherstellungswörter sind unvollständig"
          : @"The recovery words are incomplete";
      NSString* incompleteDetail = german
          ? @"Bitte gib alle 25 Wörter ein."
          : @"Please enter all 25 words.";
      NSString* retry = german ? @"Noch einmal" : @"Try again";
      while (true) {
        NSAlert* alert = [NSAlert new];
        alert.messageText = title;
        alert.informativeText = detail;
        [alert addButtonWithTitle:restore];
        [alert addButtonWithTitle:cancel];

        NSScrollView* scroll = [[NSScrollView alloc]
            initWithFrame:NSMakeRect(0, 0, 520, 190)];
        scroll.hasVerticalScroller = YES;
        scroll.borderType = NSBezelBorder;
        NSTextView* seedInput = [[NSTextView alloc]
            initWithFrame:NSMakeRect(0, 0, 500, 190)];
        seedInput.font = [NSFont preferredFontForTextStyle:NSFontTextStyleBody
                                                   options:@{}];
        seedInput.automaticQuoteSubstitutionEnabled = NO;
        seedInput.automaticDashSubstitutionEnabled = NO;
        seedInput.automaticSpellingCorrectionEnabled = NO;
        seedInput.automaticTextReplacementEnabled = NO;
        seedInput.accessibilityLabel = wordsLabel;
        scroll.documentView = seedInput;
        alert.accessoryView = scroll;

        const NSModalResponse response = [alert runModal];
        if (response != NSAlertFirstButtonReturn) {
          seedInput.string = @"";
          result = 0;
          return;
        }

        NSArray<NSString*>* parts =
            [seedInput.string componentsSeparatedByCharactersInSet:
                NSCharacterSet.whitespaceAndNewlineCharacterSet];
        NSMutableArray<NSString*>* words =
            [NSMutableArray arrayWithCapacity:25];
        for (NSString* part in parts) {
          if (part.length > 0) {
            [words addObject:part.lowercaseString];
          }
        }
        if (words.count != 25) {
          seedInput.string = @"";
          NSAlert* invalid = [NSAlert new];
          invalid.messageText = incompleteTitle;
          invalid.informativeText = incompleteDetail;
          [invalid addButtonWithTitle:retry];
          [invalid runModal];
          continue;
        }

        NSString* normalized = [words componentsJoinedByString:@" "];
        const char* utf8 = normalized.UTF8String;
        const size_t length = utf8 == nullptr ? 0 : std::strlen(utf8);
        seedInput.string = @"";
        if (length == 0 || length >= output_length) {
          result = 0;
          return;
        }
        std::memcpy(output, utf8, length);
        output[length] = '\0';
        result = 1;
        return;
      }
    };

    if (NSThread.isMainThread) {
      presentPrompt();
    } else {
      dispatch_sync(dispatch_get_main_queue(), presentPrompt);
    }
    return result;
  }
}

#endif
