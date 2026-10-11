#pragma once
#include <windows.h>
#include <bcrypt.h>
#include <filesystem>
#include <fstream>
#include <vector>
#include <string>

namespace ip {
inline std::string utf8(const std::filesystem::path& path) { const auto bytes=path.u8string(); return {reinterpret_cast<const char*>(bytes.data()),bytes.size()}; }
inline std::string fileVersion(const std::filesystem::path& path) {
    DWORD ignored=0; const auto size=GetFileVersionInfoSizeW(path.c_str(),&ignored);
    if (!size || size>4*1024*1024) return "unavailable";
    std::vector<char> bytes(size); if (!GetFileVersionInfoW(path.c_str(),0,size,bytes.data())) return "unavailable";
    VS_FIXEDFILEINFO* info=nullptr; UINT length=0;
    if (!VerQueryValueW(bytes.data(),L"\\",reinterpret_cast<void**>(&info),&length) || length<sizeof(*info)) return "unavailable";
    return std::to_string(HIWORD(info->dwFileVersionMS))+"."+std::to_string(LOWORD(info->dwFileVersionMS))+"."+std::to_string(HIWORD(info->dwFileVersionLS))+"."+std::to_string(LOWORD(info->dwFileVersionLS));
}
inline std::string sha256(const std::filesystem::path& path, std::uint64_t& budget, unsigned& status) {
    std::error_code error; const auto size=std::filesystem::file_size(path,error);
    if (error) { status=0; return {}; }
    if (size>4*1024*1024 || size>budget) { status=2; return {}; }
    budget-=size; std::ifstream file(path,std::ios::binary); std::vector<UCHAR> bytes(static_cast<size_t>(size));
    if (!file || !file.read(reinterpret_cast<char*>(bytes.data()),static_cast<std::streamsize>(size))) { status=3; return {}; }
    UCHAR digest[32]{};
    if (BCryptHash(BCRYPT_SHA256_ALG_HANDLE,nullptr,0,bytes.data(),static_cast<ULONG>(bytes.size()),digest,sizeof(digest))<0) { status=3; return {}; }
    std::string result; for (const auto b:digest) { result.push_back("0123456789abcdef"[b>>4]);result.push_back("0123456789abcdef"[b&15]); } status=1; return result;
}
inline std::string windowTitle() {
    struct Found { DWORD pid; std::wstring title; } found{GetCurrentProcessId(),{}};
    EnumWindows([](HWND window,LPARAM parameter)->BOOL { auto& f=*reinterpret_cast<Found*>(parameter); DWORD pid=0;GetWindowThreadProcessId(window,&pid);if(pid==f.pid && IsWindowVisible(window)){wchar_t title[1024]{};GetWindowTextW(window,title,1024);if(*title){f.title=title;return FALSE;}}return TRUE;},reinterpret_cast<LPARAM>(&found));
    return utf8(std::filesystem::path(found.title));
}
}
