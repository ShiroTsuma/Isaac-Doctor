#pragma once
#include <windows.h>
#include <stdexcept>
#include <string>
extern "C" {
#include "lua.h"
#include "lauxlib.h"
}

// Resolve the game's loaded Lua DLL; never load a second VM into the game.
#define IP_LUA_FUNCTIONS(X) \
    X(lua_gettop) X(lua_settop) X(lua_getglobal) X(lua_setglobal) \
    X(lua_type) X(lua_pushcclosure) X(lua_createtable) X(lua_setfield) X(lua_getfield) \
    X(lua_pushinteger) X(lua_pushnumber) X(lua_pushboolean) X(lua_pushstring) X(lua_pushnil) \
    X(lua_tointegerx) X(lua_tonumberx) X(lua_tolstring) X(lua_toboolean) \
    X(lua_pushvalue) X(lua_pushthread) X(lua_topointer) X(lua_getinfo) \
    X(lua_getupvalue) X(lua_next) X(lua_rawseti) X(lua_rotate) X(lua_error) \
    X(lua_version) X(luaL_loadbufferx) X(luaL_traceback) X(lua_pcallk) X(lua_callk) X(lua_close) X(lua_gc)
struct LuaApi {
#define IP_MEMBER(name) decltype(&name) name = nullptr;
    IP_LUA_FUNCTIONS(IP_MEMBER)
#undef IP_MEMBER
    void bind(HMODULE module) {
#define IP_BIND(name) name = reinterpret_cast<decltype(name)>(GetProcAddress(module, #name)); \
        if (!name) throw std::runtime_error("Missing Lua export: " #name);
        IP_LUA_FUNCTIONS(IP_BIND)
#undef IP_BIND
        if (lua_version(nullptr) != 504.0) throw std::runtime_error("Only Lua 5.4 is supported by this POC.");
    }
    std::string string(lua_State* L, int index) const {
        size_t size = 0;
        const char* text = lua_tolstring(L, index, &size);
        return text ? std::string(text, size) : std::string();
    }
};
