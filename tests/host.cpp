#include <windows.h>
#include <GL/gl.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
extern "C" {
#include "lua.h"
#include "lauxlib.h"
#include "lualib.h"
}
int main(int argc, char** argv) {
    if (argc < 2 || argc > 3) { std::cerr << "Usage: isaacprof-test-host scenario.lua [--graphics]\n"; return 1; }
    HDC dc = nullptr; HGLRC gl = nullptr; HWND window = nullptr;
    if (argc == 3 && std::string(argv[2]) == "--graphics") {
        WNDCLASSW cls{}; cls.style=CS_OWNDC; cls.lpfnWndProc=DefWindowProcW; cls.hInstance=GetModuleHandleW(nullptr);cls.lpszClassName=L"IsaacProf controlled GL host";
        RegisterClassW(&cls);
        window=CreateWindowW(cls.lpszClassName,L"Hidden screenshot test",WS_POPUP,0,0,640,360,nullptr,nullptr,cls.hInstance,nullptr);
        dc=GetDC(window); PIXELFORMATDESCRIPTOR pixel{};pixel.nSize=sizeof(pixel);pixel.nVersion=1;pixel.dwFlags=PFD_DRAW_TO_WINDOW|PFD_SUPPORT_OPENGL|PFD_DOUBLEBUFFER;pixel.iPixelType=PFD_TYPE_RGBA;pixel.cColorBits=32;
        const auto format=ChoosePixelFormat(dc,&pixel);
        if(!format || !SetPixelFormat(dc,format,&pixel)){std::cerr<<"Cannot select controlled GL pixel format\n";return 1;}
        gl=wglCreateContext(dc);
        if(!gl || !wglMakeCurrent(dc,gl)){std::cerr<<"Cannot create controlled GL context\n";return 1;}
    }
    std::ifstream file(argv[1], std::ios::binary);
    if (!file) return 1;
    std::ostringstream source; source << file.rdbuf();
    lua_State* L = luaL_newstate();
    if (!L) return 1;
    luaL_openlibs(L);
    lua_pushinteger(L,GetCurrentProcessId());lua_setglobal(L,"TestPid");
    const auto script = source.str();
    if (luaL_loadbuffer(L, script.data(), script.size(), "@tests/scenario.lua") || lua_pcall(L, 0, 0, 0)) {
        std::cerr << lua_tostring(L, -1) << '\n'; lua_close(L); return 1;
    }
    std::cout << "PID " << GetCurrentProcessId() << " READY" << std::endl;
    const auto deadline = GetTickCount64() + 120000;
    while (GetTickCount64() < deadline) {
        lua_getglobal(L, "TestTick");
        if (lua_pcall(L, 0, 0, 0) != LUA_OK) {
            std::cerr << lua_tostring(L, -1) << '\n'; lua_close(L); return 2;
        }
        if (dc) {
            // Owned-host engine delay for presentation diagnostics. This runs
            // after Lua returns and must not be charged to a mod callback.
            lua_getglobal(L,"TestBeforeSwapDelayMs");
            const auto delay=lua_tointeger(L,-1);lua_pop(L,1);
            if(delay>0 && delay<=100)Sleep(static_cast<DWORD>(delay));
            glViewport(0,0,640,360);glDisable(GL_SCISSOR_TEST);glClearColor(0,0,1,1);glClear(GL_COLOR_BUFFER_BIT);
            glEnable(GL_SCISSOR_TEST);glScissor(0,0,640,180);glClearColor(1,0,0,1);glClear(GL_COLOR_BUFFER_BIT);glDisable(GL_SCISSOR_TEST);
            SwapBuffers(dc);
            GLint viewport[4]{};glGetIntegerv(GL_VIEWPORT,viewport);
            if(viewport[2]!=640 || viewport[3]!=360){std::cerr<<"Screenshot hook changed GL state\n";return 3;}
        }
        Sleep(10);
    }
    lua_close(L);
    if(gl){wglMakeCurrent(nullptr,nullptr);wglDeleteContext(gl);ReleaseDC(window,dc);DestroyWindow(window);}
    return 0;
}
