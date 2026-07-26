#include "DesktopPlatformAuth.h"

#if defined(_WIN32)

#include <roapi.h>
#include <windows.h>
#include <UserConsentVerifierInterop.h>
#include <cwctype>
#include <string>
#include <vector>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Security.Credentials.UI.h>
#include <winrt/base.h>

using winrt::Windows::Foundation::IAsyncOperation;
using winrt::Windows::Security::Credentials::UI::UserConsentVerificationResult;
using winrt::Windows::Security::Credentials::UI::UserConsentVerifier;
using winrt::Windows::Security::Credentials::UI::UserConsentVerifierAvailability;

namespace {

constexpr int kSeedEditId = 1001;
constexpr int kRestoreButtonId = 1002;
constexpr int kCancelButtonId = 1003;

bool isGermanLocale() {
  wchar_t localeName[LOCALE_NAME_MAX_LENGTH] = {};
  return GetUserDefaultLocaleName(localeName, LOCALE_NAME_MAX_LENGTH) > 0 &&
      localeName[0] == L'd' && localeName[1] == L'e';
}

struct RecoveryPromptState {
  HWND parent = nullptr;
  HWND window = nullptr;
  char* output = nullptr;
  size_t outputLength = 0;
  bool completed = false;
  int result = 0;
};

void initializeApartment() {
  const HRESULT result = RoInitialize(RO_INIT_MULTITHREADED);
  if (FAILED(result) && result != RPC_E_CHANGED_MODE) {
    winrt::check_hresult(result);
  }
}

void applyDefaultFont(HWND control) {
  SendMessageW(
      control,
      WM_SETFONT,
      reinterpret_cast<WPARAM>(GetStockObject(DEFAULT_GUI_FONT)),
      TRUE);
}

std::wstring normalizedRecoverySeed(HWND edit) {
  const int length = GetWindowTextLengthW(edit);
  if (length <= 0 || length > 4096) {
    return {};
  }
  std::vector<wchar_t> raw(static_cast<size_t>(length) + 1, L'\0');
  GetWindowTextW(edit, raw.data(), static_cast<int>(raw.size()));

  std::wstring normalized;
  normalized.reserve(static_cast<size_t>(length));
  bool pendingSpace = false;
  size_t words = 0;
  for (int index = 0; index < length; ++index) {
    const wchar_t character = raw[static_cast<size_t>(index)];
    if (std::iswspace(character)) {
      pendingSpace = !normalized.empty();
      continue;
    }
    if (pendingSpace) {
      normalized.push_back(L' ');
      ++words;
      pendingSpace = false;
    }
    normalized.push_back(static_cast<wchar_t>(std::towlower(character)));
  }
  if (!normalized.empty()) {
    ++words;
  }
  SecureZeroMemory(raw.data(), raw.size() * sizeof(wchar_t));
  return words == 25 ? normalized : std::wstring{};
}

void finishRecoveryPrompt(RecoveryPromptState* state, int result) {
  if (state == nullptr || state->completed) {
    return;
  }
  state->completed = true;
  state->result = result;
  if (state->parent != nullptr) {
    EnableWindow(state->parent, TRUE);
    SetForegroundWindow(state->parent);
  }
  DestroyWindow(state->window);
}

LRESULT CALLBACK recoveryPromptWindowProc(
    HWND window,
    UINT message,
    WPARAM wParam,
    LPARAM lParam) {
  auto* state = reinterpret_cast<RecoveryPromptState*>(
      GetWindowLongPtrW(window, GWLP_USERDATA));
  if (message == WM_NCCREATE) {
    const auto* create = reinterpret_cast<CREATESTRUCTW*>(lParam);
    state = static_cast<RecoveryPromptState*>(create->lpCreateParams);
    state->window = window;
    SetWindowLongPtrW(
        window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(state));
  }

  switch (message) {
    case WM_CREATE: {
      const bool german = isGermanLocale();
      HWND title = CreateWindowExW(
          0, L"STATIC",
          german ? L"Wallet wiederherstellen" : L"Restore wallet",
          WS_CHILD | WS_VISIBLE,
          24, 20, 550, 30, window, nullptr, nullptr, nullptr);
      HWND detail = CreateWindowExW(
          0, L"STATIC",
          german
              ? L"Gib deine 25 Wiederherstellungswörter ein. Sie bleiben auf "
                L"diesem Gerät."
              : L"Enter your 25 recovery words. They stay on this device.",
          WS_CHILD | WS_VISIBLE,
          24, 56, 550, 44, window, nullptr, nullptr, nullptr);
      HWND edit = CreateWindowExW(
          WS_EX_CLIENTEDGE, L"EDIT", L"",
          WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_LEFT | ES_MULTILINE |
              ES_AUTOVSCROLL | ES_WANTRETURN | WS_VSCROLL,
          24, 110, 550, 145, window,
          reinterpret_cast<HMENU>(static_cast<INT_PTR>(kSeedEditId)),
          nullptr, nullptr);
      HWND cancel = CreateWindowExW(
          0, L"BUTTON", german ? L"Abbrechen" : L"Cancel",
          WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
          354, 278, 104, 36, window,
          reinterpret_cast<HMENU>(static_cast<INT_PTR>(kCancelButtonId)),
          nullptr, nullptr);
      HWND restore = CreateWindowExW(
          0, L"BUTTON", german ? L"Wiederherstellen" : L"Restore",
          WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_DEFPUSHBUTTON,
          470, 278, 104, 36, window,
          reinterpret_cast<HMENU>(static_cast<INT_PTR>(kRestoreButtonId)),
          nullptr, nullptr);
      for (HWND control : {title, detail, edit, cancel, restore}) {
        applyDefaultFont(control);
      }
      SetFocus(edit);
      return 0;
    }
    case WM_COMMAND:
      if (state == nullptr) {
        break;
      }
      if (LOWORD(wParam) == kCancelButtonId) {
        finishRecoveryPrompt(state, 0);
        return 0;
      }
      if (LOWORD(wParam) == kRestoreButtonId) {
        HWND edit = GetDlgItem(window, kSeedEditId);
        std::wstring seed = normalizedRecoverySeed(edit);
        if (seed.empty()) {
          const bool german = isGermanLocale();
          MessageBoxW(
              window,
              german ? L"Bitte gib alle 25 Wörter ein."
                     : L"Please enter all 25 words.",
              german ? L"Die Wiederherstellungswörter sind unvollständig"
                     : L"Recovery words are incomplete",
              MB_OK | MB_ICONWARNING);
          SetFocus(edit);
          return 0;
        }
        const int required = WideCharToMultiByte(
            CP_UTF8, WC_ERR_INVALID_CHARS, seed.data(),
            static_cast<int>(seed.size()), nullptr, 0, nullptr, nullptr);
        if (required <= 0 ||
            static_cast<size_t>(required) >= state->outputLength) {
          const bool german = isGermanLocale();
          SecureZeroMemory(seed.data(), seed.size() * sizeof(wchar_t));
          MessageBoxW(
              window,
              german ? L"Die Wiederherstellungswörter konnten nicht gelesen werden."
                     : L"The recovery words could not be read.",
              german ? L"Wallet wiederherstellen" : L"Restore wallet",
              MB_OK | MB_ICONERROR);
          return 0;
        }
        WideCharToMultiByte(
            CP_UTF8, WC_ERR_INVALID_CHARS, seed.data(),
            static_cast<int>(seed.size()), state->output, required,
            nullptr, nullptr);
        state->output[required] = '\0';
        SetWindowTextW(edit, L"");
        SecureZeroMemory(seed.data(), seed.size() * sizeof(wchar_t));
        finishRecoveryPrompt(state, 1);
        return 0;
      }
      break;
    case WM_CLOSE:
      finishRecoveryPrompt(state, 0);
      return 0;
    case WM_DESTROY:
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(window, message, wParam, lParam);
}

}  // namespace

extern "C" int tex8_desktop_system_auth_available() noexcept {
  try {
    initializeApartment();
    const auto availability =
        UserConsentVerifier::CheckAvailabilityAsync().get();
    return availability == UserConsentVerifierAvailability::Available ? 1 : 0;
  } catch (...) {
    return 0;
  }
}

extern "C" int tex8_desktop_system_authenticate(
    const char* reason,
    void* parent_window) noexcept {
  try {
    initializeApartment();
    const HWND hwnd = static_cast<HWND>(parent_window);
    if (hwnd == nullptr) {
      return 0;
    }
    const winrt::hstring prompt =
        reason != nullptr && reason[0] != '\0'
            ? winrt::to_hstring(reason)
            : winrt::hstring(L"Unlock Monero Fast Wallet");
    auto interop =
        winrt::get_activation_factory<UserConsentVerifier,
                                      ::IUserConsentVerifierInterop>();
    IAsyncOperation<UserConsentVerificationResult> operation{nullptr};
    winrt::check_hresult(interop->RequestVerificationForWindowAsync(
        hwnd,
        winrt::get_abi(prompt),
        winrt::guid_of<decltype(operation)>(),
        winrt::put_abi(operation)));
    return operation.get() == UserConsentVerificationResult::Verified ? 1 : 0;
  } catch (...) {
    return 0;
  }
}

extern "C" int tex8_desktop_prompt_recovery_seed(
    char* output,
    size_t output_length,
    void* parent_window) noexcept {
  if (output == nullptr || output_length < 2) {
    return 0;
  }
  output[0] = '\0';
  try {
    const HINSTANCE instance = GetModuleHandleW(nullptr);
    static const wchar_t* className = L"TEX8RecoverySeedPrompt";
    WNDCLASSW windowClass{};
    windowClass.lpfnWndProc = recoveryPromptWindowProc;
    windowClass.hInstance = instance;
    windowClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    windowClass.hbrBackground =
        reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
    windowClass.lpszClassName = className;
    if (RegisterClassW(&windowClass) == 0 &&
        GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
      return 0;
    }

    RecoveryPromptState state;
    state.parent = static_cast<HWND>(parent_window);
    state.output = output;
    state.outputLength = output_length;
    RECT parentRect{};
    if (state.parent == nullptr || !GetWindowRect(state.parent, &parentRect)) {
      parentRect = {100, 100, 900, 700};
    }
    const int width = 620;
    const int height = 370;
    const int x = parentRect.left +
        ((parentRect.right - parentRect.left) - width) / 2;
    const int y = parentRect.top +
        ((parentRect.bottom - parentRect.top) - height) / 2;
    if (state.parent != nullptr) {
      EnableWindow(state.parent, FALSE);
    }
    HWND window = CreateWindowExW(
        WS_EX_DLGMODALFRAME,
        className,
        isGermanLocale()
            ? L"Monero Fast Wallet – Wallet wiederherstellen"
            : L"Monero Fast Wallet – Restore wallet",
        WS_CAPTION | WS_SYSMENU,
        x, y, width, height,
        state.parent, nullptr, instance, &state);
    if (window == nullptr) {
      if (state.parent != nullptr) {
        EnableWindow(state.parent, TRUE);
      }
      return 0;
    }
    ShowWindow(window, SW_SHOW);
    UpdateWindow(window);

    MSG message{};
    while (!state.completed) {
      const BOOL received = GetMessageW(&message, nullptr, 0, 0);
      if (received <= 0) {
        break;
      }
      if (!IsDialogMessageW(window, &message)) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
      }
    }
    if (!state.completed) {
      finishRecoveryPrompt(&state, 0);
    }
    return state.result;
  } catch (...) {
    output[0] = '\0';
    return 0;
  }
}

#endif
