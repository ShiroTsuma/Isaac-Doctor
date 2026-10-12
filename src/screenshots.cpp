#include "screenshots.hpp"
#include <windows.h>
#include <GL/gl.h>
#include <MinHook.h>
#include <wincodec.h>
#include <wrl/client.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <cstring>
#include <deque>
#include <mutex>
#include <stdexcept>

namespace ip {
namespace {
using Microsoft::WRL::ComPtr;
constexpr unsigned width = 320, height = 180, stride = width * 4, imageBytes = stride * height, limit = 240;
constexpr GLenum readFbo = 0x8CA8, drawFbo = 0x8CA9, renderbuffer = 0x8D41, colorAttachment = 0x8CE0;
constexpr GLenum packBuffer = 0x88EB, packBinding = 0x88ED, streamRead = 0x88E1, syncComplete = 0x9117;
using Sync = void*;
struct Gl {
    void (APIENTRY *genFramebuffers)(GLsizei, GLuint*) = nullptr;
    void (APIENTRY *bindFramebuffer)(GLenum, GLuint) = nullptr;
    void (APIENTRY *genRenderbuffers)(GLsizei, GLuint*) = nullptr;
    void (APIENTRY *bindRenderbuffer)(GLenum, GLuint) = nullptr;
    void (APIENTRY *renderbufferStorage)(GLenum, GLenum, GLsizei, GLsizei) = nullptr;
    void (APIENTRY *framebufferRenderbuffer)(GLenum, GLenum, GLenum, GLuint) = nullptr;
    GLenum (APIENTRY *checkFramebufferStatus)(GLenum) = nullptr;
    void (APIENTRY *blitFramebuffer)(GLint, GLint, GLint, GLint, GLint, GLint, GLint, GLint, GLbitfield, GLenum) = nullptr;
    void (APIENTRY *genBuffers)(GLsizei, GLuint*) = nullptr;
    void (APIENTRY *bindBuffer)(GLenum, GLuint) = nullptr;
    void (APIENTRY *bufferData)(GLenum, std::ptrdiff_t, const void*, GLenum) = nullptr;
    void* (APIENTRY *mapBufferRange)(GLenum, std::ptrdiff_t, std::ptrdiff_t, GLbitfield) = nullptr;
    GLboolean (APIENTRY *unmapBuffer)(GLenum) = nullptr;
    Sync (APIENTRY *fenceSync)(GLenum, GLbitfield) = nullptr;
    GLenum (APIENTRY *clientWaitSync)(Sync, GLbitfield, std::uint64_t) = nullptr;
    void (APIENTRY *deleteSync)(Sync) = nullptr;
} gl;
struct Pending { GLuint buffer = 0; Sync fence = nullptr; double time = 0; unsigned generation = 0; };
struct Raw {double time; unsigned generation; std::vector<unsigned char> pixels;};
std::array<Pending, 2> pending;
GLuint fbo = 0, rb = 0;
HGLRC context = nullptr;
bool initialized = false, supported = false;
std::mutex mutex;
std::deque<Raw> queue;
ScreenshotSnapshot saved;
unsigned generation = 0, submitted = 0;
double nextTime = 0;
std::atomic<bool> enabled{false}, active{false};
std::atomic<long long> startTicks{0}, frequency{1};
decltype(&SwapBuffers) originalSwap = nullptr;
thread_local bool swapping = false;
std::atomic<bool> presentationEnabled{false};
std::atomic<unsigned> presentationGeneration{0};
std::mutex presentationMutex;
std::array<StreamPresentation, 2048> presentationSamples;
size_t presentationCount = 0;
std::uint64_t presentationDropped = 0;
long long ticks(){LARGE_INTEGER n{};QueryPerformanceCounter(&n);return n.QuadPart;}
template<class T> bool bind(T& fn, const char* name){const auto proc=wglGetProcAddress(name);if(!proc || reinterpret_cast<std::intptr_t>(proc)<=3 || reinterpret_cast<std::intptr_t>(proc)==-1)return false;fn=reinterpret_cast<T>(proc);return true;}
bool initialize(){
#define LOAD(field, name) if(!bind(gl.field, name)) return false
    LOAD(genFramebuffers,"glGenFramebuffers");LOAD(bindFramebuffer,"glBindFramebuffer");
    LOAD(genRenderbuffers,"glGenRenderbuffers");LOAD(bindRenderbuffer,"glBindRenderbuffer");
    LOAD(renderbufferStorage,"glRenderbufferStorage");LOAD(framebufferRenderbuffer,"glFramebufferRenderbuffer");
    LOAD(checkFramebufferStatus,"glCheckFramebufferStatus");LOAD(blitFramebuffer,"glBlitFramebuffer");
    LOAD(genBuffers,"glGenBuffers");LOAD(bindBuffer,"glBindBuffer");LOAD(bufferData,"glBufferData");
    LOAD(mapBufferRange,"glMapBufferRange");LOAD(unmapBuffer,"glUnmapBuffer");
    LOAD(fenceSync,"glFenceSync");LOAD(clientWaitSync,"glClientWaitSync");LOAD(deleteSync,"glDeleteSync");
#undef LOAD
    gl.genFramebuffers(1,&fbo);gl.genRenderbuffers(1,&rb);
    gl.bindFramebuffer(drawFbo,fbo);gl.bindRenderbuffer(renderbuffer,rb);
    gl.renderbufferStorage(renderbuffer,GL_RGBA8,width,height);
    gl.framebufferRenderbuffer(drawFbo,colorAttachment,renderbuffer,rb);
    if(gl.checkFramebufferStatus(drawFbo)!=0x8CD5)return false;
    for(auto& p:pending){gl.genBuffers(1,&p.buffer);gl.bindBuffer(packBuffer,p.buffer);gl.bufferData(packBuffer,imageBytes,nullptr,streamRead);}
    return true;
}
void sample(){
    if(!enabled.load())return;
    const auto current=wglGetCurrentContext();if(!current)return;
    // Objects belong to a GL context. Never use them in another window/context.
    if(context && context!=current)return;
    context=current;
    const auto before=ticks();
    std::lock_guard lock(mutex);
    const bool outstanding=std::any_of(pending.begin(),pending.end(),[](const Pending& p){return p.fence!=nullptr;});
    if(!outstanding && (!active.load() || static_cast<double>(before-startTicks.load())*1e9/static_cast<double>(frequency.load())<nextTime))return;
    GLint oldRead=0,oldDraw=0,oldPack=0,oldRb=0,oldReadBuffer=0,alignment=0,rowLength=0,skipRows=0,skipPixels=0;
    glGetIntegerv(0x8CAA,&oldRead);glGetIntegerv(0x8CA6,&oldDraw);glGetIntegerv(packBinding,&oldPack);glGetIntegerv(0x8CA7,&oldRb);
    glGetIntegerv(GL_READ_BUFFER,&oldReadBuffer);glGetIntegerv(GL_PACK_ALIGNMENT,&alignment);glGetIntegerv(GL_PACK_ROW_LENGTH,&rowLength);
    glGetIntegerv(GL_PACK_SKIP_ROWS,&skipRows);glGetIntegerv(GL_PACK_SKIP_PIXELS,&skipPixels);
    const bool scissor=glIsEnabled(GL_SCISSOR_TEST)!=0;
    if(!initialized){supported=initialize();initialized=true;}
    if(supported){
        for(auto& p:pending)if(p.fence){
            const auto ready=gl.clientWaitSync(p.fence,0,0);
            if(ready==0x911A || ready==0x911C){
                gl.bindBuffer(packBuffer,p.buffer);
                auto* bytes=static_cast<unsigned char*>(gl.mapBufferRange(packBuffer,0,imageBytes,1));
                if(bytes){if(p.generation==generation && queue.size()<2){Raw frame{p.time,generation,std::vector<unsigned char>(imageBytes)};std::memcpy(frame.pixels.data(),bytes,imageBytes);queue.push_back(std::move(frame));}else ++saved.omitted;gl.unmapBuffer(packBuffer);}else ++saved.omitted;
                gl.deleteSync(p.fence);p.fence=nullptr;
            }else if(ready==0x911D){gl.deleteSync(p.fence);p.fence=nullptr;++saved.omitted;}
        }
        const double time=static_cast<double>(before-startTicks.load())*1e9/static_cast<double>(frequency.load());
        if(active.load() && time>=nextTime){
            nextTime=time+static_cast<double>(saved.intervalMs)*1e6;
            auto slot=std::find_if(pending.begin(),pending.end(),[](const Pending& p){return !p.fence;});
            if(submitted<limit && slot!=pending.end()){
                GLint viewport[4]{};glGetIntegerv(GL_VIEWPORT,viewport);
                if(viewport[2]>0 && viewport[3]>0){
                    glDisable(GL_SCISSOR_TEST);gl.bindFramebuffer(readFbo,0);glReadBuffer(GL_BACK);
                    gl.bindFramebuffer(drawFbo,fbo);
                    gl.blitFramebuffer(viewport[0],viewport[1],viewport[0]+viewport[2],viewport[1]+viewport[3],0,0,width,height,GL_COLOR_BUFFER_BIT,GL_LINEAR);
                    gl.bindFramebuffer(readFbo,fbo);glReadBuffer(colorAttachment);gl.bindBuffer(packBuffer,slot->buffer);
                    glPixelStorei(GL_PACK_ALIGNMENT,4);glPixelStorei(GL_PACK_ROW_LENGTH,0);glPixelStorei(GL_PACK_SKIP_ROWS,0);glPixelStorei(GL_PACK_SKIP_PIXELS,0);
                    glReadPixels(0,0,width,height,0x80E1,GL_UNSIGNED_BYTE,nullptr);
                    slot->fence=gl.fenceSync(syncComplete,0);slot->time=time;slot->generation=generation;++submitted;
                    if(!slot->fence)++saved.omitted;
                }else ++saved.omitted;
            }else ++saved.omitted;
        }
    }else {if(active.load())++saved.omitted;enabled.store(false);}
    if(gl.bindFramebuffer){gl.bindFramebuffer(readFbo,static_cast<GLuint>(oldRead));glReadBuffer(static_cast<GLenum>(oldReadBuffer));gl.bindFramebuffer(drawFbo,static_cast<GLuint>(oldDraw));}
    if(gl.bindBuffer)gl.bindBuffer(packBuffer,static_cast<GLuint>(oldPack));
    if(gl.bindRenderbuffer)gl.bindRenderbuffer(renderbuffer,static_cast<GLuint>(oldRb));
    glPixelStorei(GL_PACK_ALIGNMENT,alignment);glPixelStorei(GL_PACK_ROW_LENGTH,rowLength);glPixelStorei(GL_PACK_SKIP_ROWS,skipRows);glPixelStorei(GL_PACK_SKIP_PIXELS,skipPixels);
    if(scissor)glEnable(GL_SCISSOR_TEST);
    saved.overheadNs+=static_cast<std::uint64_t>(static_cast<double>(ticks()-before)*1e9/static_cast<double>(frequency.load()));
}
BOOL WINAPI swap(HDC dc){
    if(swapping)return originalSwap(dc);
    swapping=true;
    struct SwapGuard { ~SwapGuard(){swapping=false;} } guard;
    struct Clock { unsigned generation=0; HDC dc=nullptr; HGLRC context=nullptr; long long end=0; ULONG64 cycles=0; bool cyclesValid=false; std::uint64_t id=0; };
    thread_local Clock clock;
    const auto capture=presentationGeneration.load();
    const auto glContext=wglGetCurrentContext();
    const bool measuring=active.load() && presentationEnabled.load() && glContext && wglGetCurrentDC()==dc;
    const auto readbackStart=measuring?ticks():0;
    try{sample();}catch(...){enabled.store(false);}
    const auto readbackEnd=measuring?ticks():0;
    ULONG64 beforeCycles=0,afterCycles=0;
    const bool beforeValid=measuring && QueryThreadCycleTime(GetCurrentThread(),&beforeCycles)!=0;
    const auto swapStart=measuring?ticks():0;
    const auto result=originalSwap(dc);
    const auto swapEnd=measuring?ticks():0;
    const bool afterValid=measuring && QueryThreadCycleTime(GetCurrentThread(),&afterCycles)!=0;
    if(!measuring){clock.end=0;return result;}
    if(clock.generation!=capture){clock={};clock.generation=capture;}
    if(clock.end>=startTicks.load() && clock.end>0 && clock.dc==dc && clock.context==glContext && swapEnd>clock.end){
        const auto origin=startTicks.load();
        StreamPresentation record{static_cast<std::uint64_t>(clock.end-origin),static_cast<std::uint64_t>(swapEnd-clock.end),++clock.id,
            static_cast<std::uint64_t>(swapStart-origin),static_cast<std::uint64_t>(swapEnd-swapStart),
            static_cast<std::uint64_t>(readbackStart-origin),static_cast<std::uint64_t>(readbackEnd-readbackStart),0,0,GetCurrentThreadId(),result?4u:0u};
        if(afterValid && clock.cyclesValid && afterCycles>=clock.cycles){record.cycles=afterCycles-clock.cycles;record.flags|=1;}
        if(beforeValid && afterValid && afterCycles>=beforeCycles){record.swapCycles=afterCycles-beforeCycles;record.flags|=2;}
        std::lock_guard lock(presentationMutex);
        if(active.load() && presentationEnabled.load() && presentationGeneration.load()==capture){
            if(presentationCount<presentationSamples.size())presentationSamples[presentationCount++]=record;
            else ++presentationDropped;
        }
    }
    clock.dc=dc;clock.context=glContext;clock.end=swapEnd;clock.cycles=afterCycles;clock.cyclesValid=afterValid;
    return result;
}
std::vector<unsigned char> encode(const Raw& raw){
    auto check=[](HRESULT h){if(FAILED(h))throw std::runtime_error("PNG encoder failed");};
    ComPtr<IWICImagingFactory> factory;check(CoCreateInstance(CLSID_WICImagingFactory,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&factory)));
    ComPtr<IStream> stream;check(CreateStreamOnHGlobal(nullptr,TRUE,&stream));
    ComPtr<IWICBitmapEncoder> encoder;check(factory->CreateEncoder(GUID_ContainerFormatPng,nullptr,&encoder));check(encoder->Initialize(stream.Get(),WICBitmapEncoderNoCache));
    ComPtr<IWICBitmapFrameEncode> frame;check(encoder->CreateNewFrame(&frame,nullptr));check(frame->Initialize(nullptr));check(frame->SetSize(width,height));
    WICPixelFormatGUID format=GUID_WICPixelFormat32bppBGRA;check(frame->SetPixelFormat(&format));if(format!=GUID_WICPixelFormat32bppBGRA)throw std::runtime_error("Unsupported PNG pixel format");
    for(unsigned y=0;y<height;++y)check(frame->WritePixels(1,stride,stride,const_cast<BYTE*>(raw.pixels.data()+(height-1-y)*stride)));
    check(frame->Commit());check(encoder->Commit());STATSTG stat{};check(stream->Stat(&stat,STATFLAG_NONAME));
    if(stat.cbSize.QuadPart>1048576)throw std::runtime_error("Screenshot too large");
    std::vector<unsigned char> bytes(static_cast<size_t>(stat.cbSize.QuadPart));LARGE_INTEGER zero{};check(stream->Seek(zero,STREAM_SEEK_SET,nullptr));ULONG read=0;check(stream->Read(bytes.data(),static_cast<ULONG>(bytes.size()),&read));if(read!=bytes.size())throw std::runtime_error("Truncated PNG");return bytes;
}
}
void installScreenshotHook(){
    const auto module=LoadLibraryW(L"opengl32.dll");if(!module)throw std::runtime_error("Cannot load OpenGL");
    const auto target=GetProcAddress(GetModuleHandleW(L"gdi32.dll"),"SwapBuffers");
    if(!target || MH_CreateHook(reinterpret_cast<void*>(target),swap,reinterpret_cast<void**>(&originalSwap))!=MH_OK)throw std::runtime_error("Cannot hook frame presentation");
}
void configureScreenshots(bool use, unsigned interval){enabled.store(false);std::lock_guard lock(mutex);++generation;queue.clear();saved={};saved.intervalMs=use?interval:0;submitted=0;nextTime=0;enabled.store(use);}
void configurePresentation(bool use){presentationEnabled.store(false);std::lock_guard lock(presentationMutex);++presentationGeneration;presentationCount=0;presentationDropped=0;presentationEnabled.store(use);}
std::vector<StreamPresentation> drainPresentationSamples(std::uint64_t& omitted){
    std::lock_guard lock(presentationMutex);
    std::vector<StreamPresentation> result(presentationSamples.begin(),presentationSamples.begin()+presentationCount);
    presentationCount=0;omitted=presentationDropped;presentationDropped=0;return result;
}
void setScreenshotClock(bool recording,long long start,long long freq){startTicks.store(start);frequency.store(freq);active.store(recording);}
void processScreenshots(){
    for(;;){Raw raw;{std::lock_guard lock(mutex);if(queue.empty())return;raw=std::move(queue.front());queue.pop_front();}
        try{auto png=encode(raw);std::lock_guard lock(mutex);if(raw.generation==generation)saved.images.push_back({raw.time,width,height,std::move(png)});}catch(...){std::lock_guard lock(mutex);++saved.omitted;}
    }
}
ScreenshotSnapshot screenshotSnapshot(){std::lock_guard lock(mutex);return saved;}
}
