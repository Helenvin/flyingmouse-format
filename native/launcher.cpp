#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <string>
#include <vector>

// This entry point must execute before Electron's NodeBindings initializes.
// Do not use NUL for fallback streams: unavailable NUL is the reported fault.
static std::wstring quote(const std::wstring& s) {
  std::wstring out = L"\"";
  size_t slashes = 0;
  for (wchar_t c : s) {
    if (c == L'\\') { ++slashes; continue; }
    out.append(c == L'"' ? slashes * 2 + 1 : slashes, L'\\');
    slashes = 0;
    out += c;
  }
  out.append(slashes * 2, L'\\');
  return out + L"\"";
}

static HANDLE inherited(DWORD id, HANDLE fallback) {
  HANDLE source = GetStdHandle(id), copy = nullptr;
  DWORD flags = 0;
  if (!source || source == INVALID_HANDLE_VALUE || !GetHandleInformation(source, &flags)) source = fallback;
  if (!DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &copy, 0, TRUE, DUPLICATE_SAME_ACCESS)) return nullptr;
  return copy;
}

static int fail(const wchar_t* message, DWORD code) {
  std::wstring text = message;
  text += L"\n\n错误代码 / Error: " + std::to_wstring(code);
  MessageBoxW(nullptr, text.c_str(), L"飞鼠格式 / FlyingMouse Format", MB_OK | MB_ICONERROR);
  return code ? static_cast<int>(code) : 1;
}

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  wchar_t self[32768];
  DWORD length = GetModuleFileNameW(nullptr, self, 32768);
  if (!length || length >= 32768) return fail(L"无法定位程序目录。", GetLastError());
  std::wstring directory(self, length);
  directory.resize(directory.find_last_of(L"\\/"));
  std::wstring runtime = directory + L"\\FlyingMouse Format Runtime.exe";
  if (GetFileAttributesW(runtime.c_str()) == INVALID_FILE_ATTRIBUTES)
    return fail(L"程序文件不完整，请重新安装飞鼠格式。\n缺少 FlyingMouse Format Runtime.exe。", ERROR_FILE_NOT_FOUND);

  PWSTR local = nullptr;
  HRESULT hr = SHGetKnownFolderPath(FOLDERID_LocalAppData, KF_FLAG_CREATE, nullptr, &local);
  if (FAILED(hr)) return fail(L"无法打开本地启动日志目录。", hr);
  std::wstring logs = std::wstring(local) + L"\\FlyingMouseFormat";
  CoTaskMemFree(local);
  CreateDirectoryW(logs.c_str(), nullptr);
  logs += L"\\Startup";
  CreateDirectoryW(logs.c_str(), nullptr);
  std::wstring stem = logs + L"\\startup-" + std::to_wstring(GetCurrentProcessId());
  HANDLE output = CreateFileW((stem + L".log").c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  HANDLE input = CreateFileW((stem + L".stdin").c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_DELETE_ON_CLOSE, nullptr);
  if (output == INVALID_HANDLE_VALUE || input == INVALID_HANDLE_VALUE) return fail(L"无法创建启动日志，请检查本地应用数据目录权限。", GetLastError());
  const char* header = "FlyingMouse Format compatibility bootstrap: --no-stdio-init\r\n";
  DWORD written = 0;
  WriteFile(output, header, static_cast<DWORD>(lstrlenA(header)), &written, nullptr);

  int argc = 0;
  PWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (!argv) return fail(L"无法读取启动参数。", GetLastError());
  std::wstring command = quote(runtime) + L" --no-stdio-init";
  bool cliMode = false;
  for (int i = 1; i < argc; ++i) {
    command += L" " + quote(argv[i]);
    if (std::wstring(argv[i]) == L"--cli") cliMode = true;
  }
  LocalFree(argv);
  if (command.size() >= 32767) return fail(L"启动参数过长。", ERROR_BAD_LENGTH);
  // Only the user-facing launcher clears inherited development settings.
  // Internal Electron/Node workers use the runtime executable directly.
  SetEnvironmentVariableW(L"ELECTRON_RUN_AS_NODE", nullptr);
  SetEnvironmentVariableW(L"NODE_OPTIONS", nullptr);
  STARTUPINFOEXW si = {};
  si.StartupInfo.cb = sizeof(si);
  si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  si.StartupInfo.hStdInput = inherited(STD_INPUT_HANDLE, input);
  si.StartupInfo.hStdOutput = inherited(STD_OUTPUT_HANDLE, output);
  si.StartupInfo.hStdError = inherited(STD_ERROR_HANDLE, output);
  HANDLE handles[] = { si.StartupInfo.hStdInput, si.StartupInfo.hStdOutput, si.StartupInfo.hStdError };
  for (HANDLE h : handles) if (!h) return fail(L"无法准备启动输入输出。", GetLastError());
  SIZE_T attributeBytes = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeBytes);
  std::vector<BYTE> storage(attributeBytes);
  si.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  if (!InitializeProcThreadAttributeList(si.lpAttributeList, 1, 0, &attributeBytes)) return fail(L"无法准备启动环境。", GetLastError());
  if (!UpdateProcThreadAttribute(si.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, sizeof(handles), nullptr, nullptr)) return fail(L"无法设置启动输入输出。", GetLastError());
  PROCESS_INFORMATION pi = {};
  BOOL ok = CreateProcessW(runtime.c_str(), command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, nullptr, nullptr, &si.StartupInfo, &pi);
  DWORD error = GetLastError();
  DeleteProcThreadAttributeList(si.lpAttributeList);
  for (HANDLE h : handles) CloseHandle(h);
  CloseHandle(input);
  if (!ok) { CloseHandle(output); return fail(L"无法启动飞鼠格式，请重新安装后重试。", error); }
  CloseHandle(pi.hThread);
  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD code = 0;
  GetExitCodeProcess(pi.hProcess, &code);
  CloseHandle(pi.hProcess);
  std::string footer = "\r\nRuntime exit code: " + std::to_string(code) + "\r\n";
  WriteFile(output, footer.data(), static_cast<DWORD>(footer.size()), &written, nullptr);
  CloseHandle(output);
  if (code != 0 && !cliMode) return fail((L"飞鼠格式异常退出。请将启动日志发给开发者：\n" + stem + L".log").c_str(), code);
  return static_cast<int>(code);
}
