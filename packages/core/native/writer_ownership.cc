// Internal Node-API FD locks. Caller retains the FileHandle until release.
#include <node_api.h>
#include <cstdint>
#include <mutex>
#include <unordered_map>
#ifdef _WIN32
#include <windows.h>
#include <io.h>
#else
#include <cerrno>
#include <sys/file.h>
#include <sys/stat.h>
#endif
struct Identity { uint64_t volume, inode; };
static std::mutex guard;
static std::unordered_map<int,Identity> owned;
static bool identify(int fd,Identity &id) {
#ifdef _WIN32
  HANDLE handle=(HANDLE)_get_osfhandle(fd); BY_HANDLE_FILE_INFORMATION info;
  if(handle==INVALID_HANDLE_VALUE || GetFileType(handle)!=FILE_TYPE_DISK || !GetFileInformationByHandle(handle,&info) || (info.dwFileAttributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT)))return false;
  id={info.dwVolumeSerialNumber,((uint64_t)info.nFileIndexHigh<<32)|info.nFileIndexLow};
#else
  struct stat info;if(fstat(fd,&info)!=0||!S_ISREG(info.st_mode))return false;
  id={(uint64_t)info.st_dev,(uint64_t)info.st_ino};
#endif
  return true;
}
static napi_value fail(napi_env env,const char *message){napi_throw_error(env,nullptr,message);return nullptr;}
static bool get_fd(napi_env env,napi_callback_info info,int &fd){size_t count=1;napi_value arg;napi_valuetype type;int32_t value;
  if(napi_get_cb_info(env,info,&count,&arg,nullptr,nullptr)!=napi_ok||count!=1||napi_typeof(env,arg,&type)!=napi_ok||type!=napi_number||napi_get_value_int32(env,arg,&value)!=napi_ok||value<0){fail(env,"Expected an owned regular-file descriptor");return false;}
  double exact;if(napi_get_value_double(env,arg,&exact)!=napi_ok||exact!=value){fail(env,"Invalid descriptor");return false;}fd=value;return true;
}
static napi_value try_lock(napi_env env,napi_callback_info info){int fd;if(!get_fd(env,info,fd))return nullptr;std::lock_guard<std::mutex> lock(guard);Identity id;
  if(owned.count(fd))return fail(env,"Descriptor is already owned");
  if(!identify(fd,id))return fail(env,"Lock descriptor is not an ordinary file");
  bool acquired;
#ifdef _WIN32
  OVERLAPPED offset={};acquired=LockFileEx((HANDLE)_get_osfhandle(fd),LOCKFILE_EXCLUSIVE_LOCK|LOCKFILE_FAIL_IMMEDIATELY,0,0xffffffff,0xffffffff,&offset)!=0;
  if(!acquired&&GetLastError()!=ERROR_LOCK_VIOLATION)return fail(env,"OS lock acquisition failed");
#else
  acquired=flock(fd,LOCK_EX|LOCK_NB)==0;if(!acquired&&errno!=EWOULDBLOCK&&errno!=EAGAIN)return fail(env,"OS lock acquisition failed");
#endif
  if(acquired){owned.emplace(fd,id);}
  napi_value result;if(napi_get_boolean(env,acquired,&result)!=napi_ok)return fail(env,"Cannot publish lock result");return result;
}
static napi_value release(napi_env env,napi_callback_info info){int fd;if(!get_fd(env,info,fd))return nullptr;std::lock_guard<std::mutex> lock(guard);auto found=owned.find(fd);Identity now;
  if(found==owned.end())return fail(env,"Cannot release an unknown owner");
  if(!identify(fd,now)||now.volume!=found->second.volume||now.inode!=found->second.inode)return fail(env,"Owned descriptor identity changed");
#ifdef _WIN32
  OVERLAPPED offset={};if(!UnlockFileEx((HANDLE)_get_osfhandle(fd),0,0xffffffff,0xffffffff,&offset))return fail(env,"OS lock release failed");
#else
  if(flock(fd,LOCK_UN)!=0)return fail(env,"OS lock release failed");
#endif
  owned.erase(found);napi_value result;napi_get_undefined(env,&result);return result;
}
static napi_value init(napi_env env,napi_value exports){napi_property_descriptor properties[]={{"tryLock",nullptr,try_lock,nullptr,nullptr,nullptr,napi_default,nullptr},{"release",nullptr,release,nullptr,nullptr,nullptr,napi_default,nullptr}};
  if(napi_define_properties(env,exports,2,properties)!=napi_ok)return fail(env,"Cannot initialize OS ownership addon");
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
