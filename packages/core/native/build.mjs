/** Production addon build; no dependency downloads or filesystem test setup. */
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const directory=dirname(fileURLToPath(import.meta.url));
if(process.platform!=='linux'&&process.platform!=='darwin')throw new Error('Native ownership build is not yet supported on this platform');
const headers=resolve(process.env.NODE_API_INCLUDE_DIR??'/usr/include/node');
for(const name of ['node_api.h','node_api_types.h','js_native_api.h','js_native_api_types.h'])if(!existsSync(join(headers,name)))throw new Error(`Missing Node-API headers: set NODE_API_INCLUDE_DIR to a trusted Node SDK include directory`);
const args=['-std=c++17','-Wall','-Wextra','-Werror','-fPIC','-shared','-DNAPI_VERSION=8','-DNODE_GYP_MODULE_NAME=writer_ownership','-I',headers,join(directory,'writer_ownership.cc'),'-o',join(directory,'writer_ownership.node')];
if(process.platform==='darwin')args.unshift('-undefined','dynamic_lookup');
const result=spawnSync(process.env.CXX??'c++',args,{shell:false,stdio:'inherit',timeout:60000});
if(result.error)throw result.error;if(result.status!==0)throw new Error(`Native ownership compiler failed: ${result.status}`);
