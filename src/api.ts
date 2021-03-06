/**
 Dwarf - Copyright (C) 2019 Giovanni Rocca (iGio90)

 This program is free software: you can redistribute it and/or modify
 it under the terms of the GNU General Public License as published by
 the Free Software Foundation, either version 3 of the License, or
 (at your option) any later version.

 This program is distributed in the hope that it will be useful,
 but WITHOUT ANY WARRANTY; without even the implied warranty of
 MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 GNU General Public License for more details.

 You should have received a copy of the GNU General Public License
 along with this program.  If not, see <https://www.gnu.org/licenses/>
 **/

import { Dwarf } from "./dwarf";
import { FileSystem } from "./fs";
import { LogicBreakpoint } from "./logic_breakpoint";
import { LogicJava } from "./logic_java";
import { LogicObjC } from "./logic_objc";
import { LogicInitialization } from "./logic_initialization";
import {LogicStalker, NativeTracerCallbacks} from "./logic_stalker";
import { LogicWatchpoint } from "./logic_watchpoint";
import { ThreadWrapper } from "./thread_wrapper";
import { Utils } from "./utils";
import {
    MEMORY_ACCESS_EXECUTE,
    MEMORY_ACCESS_READ,
    MEMORY_ACCESS_WRITE
} from "./watchpoint";
import { ELF_File } from "./elf_file";

export class Api {
    private static _internalMemoryScan(start, size, pattern) {
        if (size > 4096) {
            // scan in chunks of 4096
            let _start = parseInt(start);
            const end = _start + size;
            let result = [];
            let _break = false;
            while (true) {
                let s = 4096;
                if (_start + s > end) {
                    s = end - _start;
                    _break = true;
                }
                result = result.concat(Memory.scanSync(start, s, pattern));
                if (_break || result.length >= 100) {
                    break;
                }
                start = start.add(size);
                _start += s;
            }
            return result;
        } else {
            return Memory.scanSync(start, size, pattern);
        }
    }

    /**
     * Shortcut to retrieve native backtrace
     *
     * ```javascript
     * Interceptor.attach(targetPtr, function() {
     *     console.log(backtrace(this.context));
     * }
     * ```
     */
    static backtrace(context?: CpuContext): DebugSymbol[] | null {
        if (!Utils.isDefined(context)) {
            context = Dwarf.threadContexts[Process.getCurrentThreadId()];
            if (!Utils.isDefined(context)) {
                return null;
            }
        }

        return Thread.backtrace(context, Backtracer.ACCURATE).map(
            DebugSymbol.fromAddress
        );
    }

    /**
     * Enumerate exports for the given module name or pointer
     *
     * ```javascript
     * enumerateExports(Process.findModuleByName('libtarget.so'));
     * ```
     */
    static enumerateExports(module: any): Array<ModuleExportDetails> {
        if (typeof module !== "object") {
            module = Api.findModule(module);
        }
        if (module !== null) {
            if (Dwarf.modulesBlacklist.indexOf(module.name) >= 0) {
                return [];
            }
            return module.enumerateExports();
        }
        return [];
    }

    /**
     * Enumerate imports for the given module name or pointer
     *
     * ```javascript
     * enumerateImports(Process.findModuleByName('libtarget.so'));
     * ```
     */
    static enumerateImports(module): Array<ModuleExportDetails> {
        if (typeof module !== "object") {
            module = Api.findModule(module);
        }
        if (module !== null) {
            if (Dwarf.modulesBlacklist.indexOf(module.name) >= 0) {
                return [];
            }
            return module.enumerateImports();
        }
        return [];
    }

    /**
     * Enumerate java classes
     *
     * ```javascript
     * enumerateJavaClasses().forEach(function(clazz) {
     *     console.log(clazz);
     * });;
     * ```
     */
    static enumerateJavaClasses(useCache?) {
        if (!Utils.isDefined(useCache)) {
            useCache = false;
        }

        if (
            useCache &&
            LogicJava !== null &&
            LogicJava.javaClasses.length > 0
        ) {
            Dwarf.loggedSend("enumerate_java_classes_start:::");
            for (let i = 0; i < LogicJava.javaClasses.length; i++) {
                send(
                    "enumerate_java_classes_match:::" + LogicJava.javaClasses[i]
                );
            }
            Dwarf.loggedSend("enumerate_java_classes_complete:::");
        } else {
            // invalidate cache
            if (LogicJava !== null) {
                LogicJava.javaClasses = [];
            }

            Java.performNow(function() {
                Dwarf.loggedSend("enumerate_java_classes_start:::");
                try {
                    const mainLoader = Java.classFactory.loader;
                    let ldr = Java.enumerateClassLoadersSync();
                    let n = 0;
                    ldr.forEach(function (loaderz) {
                        Java.classFactory.loader = loaderz;
                        Java.enumerateLoadedClasses({
                            onMatch: function(className) {
                                if (LogicJava !== null) {
                                    LogicJava.javaClasses.push(className);
                                }
                                send("enumerate_java_classes_match:::" + className);
                            },
                            onComplete: function() {
                                n++;
                                if (n === ldr.length) {
                                    Dwarf.loggedSend(
                                        "enumerate_java_classes_complete:::"
                                    );
                                }
                            }
                        });
                    });
                    Java.classFactory.loader = mainLoader;
                } catch (e) {
                    Utils.logErr("enumerateJavaClasses", e);
                    Dwarf.loggedSend("enumerate_java_classes_complete:::");
                }
            });
        }
    }

    /**
     * Enumerate method for the given class name
     *
     * ```javascript
     * enumerateJavaMethods('android.app.Activity');
     * ```
     */
    static enumerateJavaMethods(className: string): void {
        if (Java.available) {
            const that = this;
            Java.performNow(function() {
                try {
                    // 0xdea code -> https://github.com/0xdea/frida-scripts/blob/master/raptor_frida_android_trace.js
                    const clazz = Java.use(className);
                    const methods = clazz.class.getDeclaredMethods();
                    const parsedMethods = [];
                    methods.forEach(function(method) {
                        parsedMethods.push(
                            method
                                .toString()
                                .replace(className + ".", "TOKEN")
                                .match(/\sTOKEN(.*)\(/)[1]
                        );
                    });
                    const result = Utils.uniqueBy(parsedMethods);
                    Dwarf.loggedSend(
                        "enumerate_java_methods_complete:::" +
                            className +
                            ":::" +
                            JSON.stringify(result)
                    );
                } catch (e) {
                    Utils.logErr("classMethods", e);
                }
            });
        }
    }

    /**
     * Enumerate modules for ObjC inspector panel
     *
     * ```javascript
     * enumerateObjCModules();
     * ```
     */
    static enumerateObjCModules(): void {
        const modules = Process.enumerateModules();
        const names = modules.map(m => m.name);
        Dwarf.loggedSend("enumerate_objc_modules:::" + JSON.stringify(names));
    }

    /**
     * Enumerate ObjC classes in the given module
     *
     * ```javascript
     * enumerateObjCClasses('module');
     * ```
     */
    static enumerateObjCClasses(moduleName: string) {
        Dwarf.loggedSend("enumerate_objc_classes_start:::");
        try {
            ObjC.enumerateLoadedClasses(
                {
                    ownedBy: new ModuleMap(m => {
                        return moduleName === m["name"];
                    })
                },
                {
                    onMatch: function(className) {
                        if (LogicObjC !== null) {
                            LogicObjC.objcClasses.push(className);
                        }
                        send("enumerate_objc_classes_match:::" + className);
                    },
                    onComplete: function() {
                        send("enumerate_objc_classes_complete:::");
                    }
                }
            );
        } catch (e) {
            Utils.logErr("enumerateObjCClasses", e);
            Dwarf.loggedSend("enumerate_objc_classes_complete:::");
        }
    }

    /**
     * Enumerate ObjC methods for the given class
     *
     * ```javascript
     * enumerateObjCMethods('class');
     * ```
     */
    static enumerateObjCMethods(className: string): void {
        if (ObjC.available) {
            Dwarf.loggedSend("enumerate_objc_methods_start:::");
            const that = this;
            const clazz = ObjC.classes[className];
            const methods = clazz.$ownMethods;

            methods.forEach(function(method) {
                send("enumerate_objc_methods_match:::" + method);
            });
            Dwarf.loggedSend("enumerate_objc_methods_complete:::");
        }
    }

    /**
     * Enumerate loaded modules
     *
     * ```javascript
     * enumerateModules(true); // symbols, exports and imports - yes please.
     * ```
     */
    static enumerateModules(fillInformation?: boolean) {
        fillInformation = fillInformation || false;

        const modules = Process.enumerateModules();
        if (fillInformation) {
            for (let i = 0; i < modules.length; i++) {
                if (Dwarf.modulesBlacklist.indexOf(modules[i].name) >= 0) {
                    continue;
                }

                // skip ntdll on windoof (access_violation)
                if (Process.platform === "windows") {
                    if (modules[i].name === "ntdll.dll") {
                        continue;
                    }
                } else if (Process.platform === "linux") {
                    if (LogicJava !== null) {
                        if (LogicJava.sdk <= 23) {
                            if (modules[i].name === "app_process") {
                                continue;
                            }
                        }
                    }
                }

                modules[i] = Api.enumerateModuleInfo(modules[i]);
            }
        }
        return modules;
    }

    /**
     * Enumerate all information about the module (imports / exports / symbols)
     *
     * ```javascript
     * enumerateModuleInfo(Process.findModuleByName('target.so'));
     * ```
     */
    /*
        TODO: recheck! when doc says object from frida-gum it shouldnt used by dwarf with string
              fix on pyside and remove the string stuff here
              return should also DwarfModule as Module is altered

        module_info.py
        def update_details(self, dwarf, base_info):
            details = dwarf.dwarf_api('enumerateModuleInfo', base_info['name'])
    */
    static enumerateModuleInfo(fridaModule: Module | string): Module {
        let _module: Module = null;

        if (Utils.isString(fridaModule)) {
            _module = Process.findModuleByName(fridaModule as string);
        } else {
            _module = fridaModule as Module;
        }

        if (Dwarf.modulesBlacklist.indexOf(_module.name) >= 0) {
            Api.log("Error: Module " + _module.name + " is blacklisted");
            return _module;
        }

        try {
            _module["imports"] = _module.enumerateImports();
            _module["exports"] = _module.enumerateExports();
            _module["symbols"] = _module.enumerateSymbols();
        } catch (e) {
            return _module;
        }

        _module["entry"] = null;
        const header = _module.base.readByteArray(4);
        if (
            header[0] !== 0x7f &&
            header[1] !== 0x45 &&
            header[2] !== 0x4c &&
            header[3] !== 0x46
        ) {
            // Elf
            _module["entry"] = _module.base.add(24).readPointer();
        }

        return _module;
    }

    /**
     * Enumerate all mapped ranges
     *
     * ```javascript
     * enumerateRanges().forEach(function(range) {
     *     console.log(range.base, range.size);
     * });
     * ```
     */
    static enumerateRanges(): RangeDetails[] {
        return Process.enumerateRanges("---");
    }

    /**
     * Enumerate symbols for the given module name or pointer
     *
     * ```javascript
     * enumerateSymbols('module');
     * ```
     */
    static enumerateSymbols(module): Array<ModuleSymbolDetails> {
        if (typeof module !== "object") {
            module = Api.findModule(module);
        }
        if (module !== null) {
            if (Dwarf.modulesBlacklist.indexOf(module.name) >= 0) {
                return [];
            }
            return module.enumerateSymbols();
        }
        return [];
    }

    /**
     * Evaluate javascript. Used from the UI to inject javascript code into the process
     *
     * ```javascript
     * evaluate('console.log(1)');
     * ```
     */
    static evaluate(jsCode: string) {
        const Thread = ThreadWrapper;
        try {
            return eval(jsCode);
        } catch (e) {
            Api.log(e.toString());
            return null;
        }
    }

    /**
     * Evaluate javascript. Used from the UI to inject javascript code into the process
     *
     * ```javascript
     * evaluateFunction('(function() {
     *     // do stuff
     * })();');
     * ```
     */
    static evaluateFunction(jsFnc: string) {
        try {
            const fn = new Function("Thread", jsFnc);
            return fn.apply(this, [ThreadWrapper]);
        } catch (e) {
            Api.log(e.toString());
            return null;
        }
    }

    /**
     * Evaluate any input and return a NativePointer
     *
     * ```javascript
     * evaluatePtr(10 + 10 + 0xabcd);
     * evaluatePtr('0xabcd');
     * ```
     */
    static evaluatePtr(pointer: any): NativePointer {
        try {
            return ptr(eval(pointer));
        } catch (e) {
            return NULL;
        }
    }

    /**
     * Shortcut to quickly retrieve an export
     *
     * ```javascript
     * const openAddress = findExport('open');
     * const myTargetAddress = findExport('target_func', 'target_module.so');
     * ```
     */
    static findExport(name, module?): NativePointer | null {
        if (typeof module === "undefined") {
            module = null;
        }
        return Module.findExportByName(module, name);
    }

    /**
     * Find a module providing any argument. Could be a string/int pointer or module name
     *
     * ```javascript
     * findModule('mymodule');
     * ```
     */
    static findModule(module: any): Module | Module[] | null {
        let _module;
        if (Utils.isString(module) && module.substring(0, 2) !== "0x") {
            _module = Process.findModuleByName(module);
            if (Utils.isDefined(_module)) {
                return _module;
            } else {
                // do wildcard search
                if (module.indexOf("*") !== -1) {
                    const modules = Process.enumerateModules();
                    const searchName = module.toLowerCase().split("*")[0];
                    for (let i = 0; i < modules.length; i++) {
                        // remove non matching
                        if (
                            modules[i].name
                                .toLowerCase()
                                .indexOf(searchName) === -1
                        ) {
                            modules.splice(i, 1);
                            i--;
                        }
                    }
                    if (modules.length === 1) {
                        return modules[0];
                    } else {
                        return modules;
                    }
                }
            }
        } else {
            _module = Process.findModuleByAddress(ptr(module));
            if (!Utils.isDefined(_module)) {
                _module = {};
            }
            return _module;
        }
        return null;
    }

    /**
     * Find a symbol matching the given pattern
     *
     * ```javascript
     * findSymbol('*link*');
     * ```
     */
    static findSymbol(pattern) {
        return DebugSymbol.findFunctionsMatching(pattern);
    }

    /**
     * get telescope information for the given pointer argument
     *
     * ```javascript
     * getAddressTs(0xdeadbeef);
     * ```
     */
    static getAddressTs(p) {
        const _ptr = ptr(p);
        const _range = Process.findRangeByAddress(_ptr);
        if (Utils.isDefined(_range)) {
            if (_range.protection.indexOf("r") !== -1) {
                try {
                    const s = Api.readString(_ptr);
                    if (s !== "") {
                        return [0, s];
                    }
                } catch (e) {}
                try {
                    const ptrVal = _ptr.readPointer();
                    return [1, ptrVal];
                } catch (e) {}
                return [2, p];
            }
        }
        return [-1, p];
    }

    /**
     * Return an array of DebugSymbol for the requested pointers
     *
     * ```javascript
     * getDebugSymbols([ptr(0x1234), ptr(0xabcd)]);
     * ```
     */
    static getDebugSymbols(ptrs): DebugSymbol[] {
        const symbols = [];
        if (Utils.isDefined(ptrs)) {
            try {
                ptrs = JSON.parse(ptrs);
            } catch (e) {
                Utils.logErr("getDebugSymbols", e);
                return symbols;
            }
            for (let i = 0; i < ptrs.length; i++) {
                symbols.push(Api.getSymbolByAddress(ptrs[i]));
            }
        }
        return symbols;
    }

    /**
     * Shortcut to retrieve an Instruction object for the given address
     *
     * ```javascript
     * getInstruction(0xabcd);
     * ```
     */
    static getInstruction(address) {
        try {
            const instruction = Instruction.parse(ptr(address));
            return JSON.stringify({
                string: instruction.toString()
            });
        } catch (e) {
            Utils.logErr("getInstruction", e);
        }
        return null;
    }

    /**
     * Return a RangeDetails object or null for the requested pointer
     *
     * ```javascript
     * getRange(0xabcd);
     * ```
     */
    static getRange(address: any): RangeDetails | null {
        try {
            const nativeAddress = ptr(address);
            if (
                nativeAddress === null ||
                parseInt(nativeAddress.toString()) === 0
            ) {
                return null;
            }
            const ret = Process.findRangeByAddress(nativeAddress);
            if (ret == null) {
                return null;
            }
            return ret;
        } catch (e) {
            Utils.logErr("getRange", e);
            return null;
        }
    }

    /**
     * Return DebugSymbol or null for the given pointer
     *
     * ```javascript
     * getSymbolByAddress(0xabcd);
     * ```
     */
    static getSymbolByAddress(pt): DebugSymbol | null {
        try {
            pt = ptr(pt);
            return DebugSymbol.fromAddress(pt);
        } catch (e) {
            Utils.logErr("getSymbolByAddress", e);
            return null;
        }
    }

    /**
     * Return elf headers of module
     *
     * ```javascript
     * getELFHeader(); //returns elfheader of MainProcess
     *
     * getELFHeader('libwhatever.so');
     * ```
     */
    static getELFHeader(moduleName: string, isUICall?: boolean): ELF_File | null {
        if (!Utils.isDefined(isUICall)) {
            isUICall = false;
        }
        if (!Utils.isString(moduleName)) {
            throw new Error("Api::getELFHeader() => No moduleName given!");
        }
        const fridaModule = Process.findModuleByName(moduleName);
        if (Utils.isDefined(fridaModule) && Utils.isString(fridaModule.path)) {
            try {
                let elfFile = new ELF_File(fridaModule.path);
                if (Utils.isDefined(elfFile)) {
                    if (isUICall) {
                        send({
                            elf_info: elfFile
                        });
                    }
                    return elfFile;
                }
            } catch (error) {
                console.log(error);
            }
        } else {
            if (isUICall) {
                throw new Error("Api::getELFHeader() => Module not found!");
            }
        }
        return null;
    }

    /**
     * Hook all the methods for the given java class
     *
     * ```javascript
     * hookAllJavaMethods('android.app.Activity', function() {
     *     console.log('hello from:', this.className, this.method);
     * })
     * ```
     */
    static hookAllJavaMethods(className: string, callback: Function): boolean {
        return LogicJava.hookAllJavaMethods(className, callback);
    }

    /**
     * Receive a callback whenever a java class is going to be loaded by the class loader.
     *
     * ```javascript
     * hookClassLoaderClassInitialization('com.target.classname', function() {
     *     console.log('target is being loaded');
     * })
     * ```
     */
    static hookClassLoaderClassInitialization(className: string, callback: Function): boolean {
        return LogicJava.hookClassLoaderClassInitialization(
            className,
            callback
        );
    }

    /**
     * Hook the constructor of the given java class
     * ```javascript
     * hookJavaConstructor('android.app.Activity', function() {
     *     console.log('activity created');
     * })
     * ```
     */
    static hookJavaConstructor(className: string, callback: Function): boolean {
        return LogicJava.hook(className, "$init", callback);
    }

    /**
     * Hook the constructor of the given java class
     * ```javascript
     * hookJavaConstructor('android.app.Activity.onCreate', function() {
     *     console.log('activity created');
     *     var savedInstanceState = arguments[0];
     *     if (savedInstanceState !== null) {
     *         return this.finish();
     *     } else {
     *         return this.overload.call(this, arguments);
     *     }
     * })
     * ```
     */
    static hookJavaMethod(targetClassMethod: string, callback: Function): boolean {
        return LogicJava.hookJavaMethod(targetClassMethod, callback);
    }

    /**
     * Receive a callback when the native module is being loaded
     * ```javascript
     * hookModuleInitialization('libtarget.so', function() {
     *     console.log('libtarget is being loaded');
     * });
     * ```
     */
    static hookModuleInitialization(moduleName: string, callback: Function): boolean {
        return LogicInitialization.hookModuleInitialization(
            moduleName,
            callback
        );
    }

    /**
     * Map the given blob as hex string using memfd:create with the given name
     *
     * ```javascript
     * injectBlob('blob', 'aabbccddeeff');
     * ```
     */
    static injectBlob(name: string, blob: string) {
        // arm syscall memfd_create
        let sys_num = 385;
        if (Process.arch === "ia32") {
            sys_num = 356;
        } else if (Process.arch === "x64") {
            sys_num = 319;
        }

        const syscall_ptr = Api.findExport("syscall");
        const write_ptr = Api.findExport("write");
        const dlopen_ptr = Api.findExport("dlopen");

        if (syscall_ptr !== null && !syscall_ptr.isNull()) {
            const syscall = new NativeFunction(syscall_ptr, "int", [
                "int",
                "pointer",
                "int"
            ]);
            if (write_ptr !== null && !write_ptr.isNull()) {
                const write = new NativeFunction(write_ptr, "int", [
                    "int",
                    "pointer",
                    "int"
                ]);
                if (dlopen_ptr !== null && !dlopen_ptr.isNull()) {
                    const dlopen = new NativeFunction(dlopen_ptr, "int", [
                        "pointer",
                        "int"
                    ]);

                    const m = FileSystem.allocateRw(128);
                    m.writeUtf8String(name);
                    const fd = syscall(sys_num, m, 0);
                    if (fd > 0) {
                        const hexArr = Utils.hex2a(blob);
                        const blob_space = Memory.alloc(hexArr.length);
                        Memory.protect(blob_space, hexArr.length, "rwx");
                        blob_space.writeByteArray(hexArr);
                        write(fd, blob_space, hexArr.length);
                        m.writeUtf8String("/proc/" + Process.id + "/fd/" + fd);
                        return dlopen(m, 1);
                    } else {
                        return -4;
                    }
                } else {
                    return -3;
                }
            } else {
                return -2;
            }
        } else {
            return -1;
        }
    }

    /**
     * ```javascript
     * var alreadyWatched = isAddressWatched(0x1234);
     * ```
     */
    static isAddressWatched(pt: any): boolean {
        const watchpoint =
            LogicWatchpoint.memoryWatchpoints[ptr(pt).toString()];
        return Utils.isDefined(watchpoint);
    }

    private static isPrintable(char) {
        try {
            const isprint_ptr = Api.findExport("isprint");
            if (Utils.isDefined(isprint_ptr)) {
                const isprint_fn = new NativeFunction(isprint_ptr, "int", [
                    "int"
                ]);
                if (Utils.isDefined(isprint_fn)) {
                    return isprint_fn(char);
                }
            } else {
                if (char > 31 && char < 127) {
                    return true;
                }
            }
            return false;
        } catch (e) {
            Utils.logErr("isPrintable", e);
            return false;
        }
    }

    /**
     * get the java stack trace. Must be executed in JVM thread
     *
     * ```javascript
     * Java.perform(function() {
     *     console.log(javaBacktrace());
     * });
     * ```
     */
    static javaBacktrace() {
        return LogicJava.backtrace();
    }

    /**
     * get the explorer object for the given java handle.
     * required by UI
     */
    static jvmExplorer(handle) {
        return LogicJava.jvmExplorer(handle);
    }

    /**
     * log whatever to Dwarf console
     *
     * ```javascript
     * log('12345');
     * ```
     */
    static log(message?: any, ...optionalParams: any[]): void {
        if (Utils.isDefined(message)) {
            if (Dwarf.UI) {
                if (optionalParams.length > 0) {
                    optionalParams.forEach(function (param) {
                        message += ' ' + param;
                    });
                }
                Dwarf.loggedSend("log:::" + message);
            } else {
                console.log(message, optionalParams)
            }
        }
    }

    private static memoryScan(start, size, pattern) {
        let result = [];
        try {
            result = Api._internalMemoryScan(ptr(start), size, pattern);
        } catch (e) {
            Utils.logErr("memoryScan", e);
        }
        Dwarf.loggedSend("memoryscan_result:::" + JSON.stringify(result));
    }

    private static memoryScanList(ranges, pattern) {
        ranges = JSON.parse(ranges);
        let result = [];
        for (let i = 0; i < ranges.length; i++) {
            try {
                result = result.concat(
                    Api._internalMemoryScan(
                        ptr(ranges[i]["start"]),
                        ranges[i]["size"],
                        pattern
                    )
                );
            } catch (e) {
                Utils.logErr("memoryScanList", e);
            }
            if (result.length >= 100) {
                break;
            }
        }
        Dwarf.loggedSend("memoryscan_result:::" + JSON.stringify(result));
    }

    /**
     * put a breakpoint on a native pointer or a java class with an optional evaluated condition
     *
     * ```javascript
     * var nativeTarget = findExport('memcpy');
     *
     * putBreakpoint(nativeTarget);
     *
     * nativeTarget = findExport('open');
     * putBreakpoint(target, function() {
     *     if (this.context.x0.readUtf8String().indexOf('prefs.json') >= 0) {
     *         return true;
     *     }
     *
     *     return false;
     * });
     *
     * var javaTarget = 'android.app.Activity.onCreate';
     * putBreakpoint(javaTarget);
     * ```
     */
    static putBreakpoint(address_or_class: any, condition?: string | Function): boolean {
        return LogicBreakpoint.putBreakpoint(address_or_class, condition);
    }

    /**
     * Put a java class initialization breakpoint
     *
     * ```javascript
     * putJavaClassInitializationBreakpoint('android.app.Activity');
     * ```
     */
    static putJavaClassInitializationBreakpoint(className: string): boolean {
        return LogicJava.putJavaClassInitializationBreakpoint(className);
    }

    /**
     * Put a native module initialization breakpoint
     *
     * ```javascript
     * putModuleInitializationBreakpoint('libtarget.so');
     * ```
     */
    static putModuleInitializationBreakpoint(moduleName: string): boolean {
        return LogicInitialization.putModuleInitializationBreakpoint(
            moduleName
        );
    }

    /**
     * Put a watchpoint on the given address
     *
     * ```javascript
     * putWatchpoint(0x1000, 'r');
     *
     * var target = findExport('memcpy');
     * Interceptor.attach(target, {
     *     onLeave: function(ret) {
     *         putWatchpoint(this.context.x0, 'rw', function() {
     *            log(backtrace(this.context));
     *         });
     *     }
     * });
     * ```
     */
    static putWatchpoint(address: any, flags: string | number, callback?: Function) {
        let intFlags = 0;
        if (!Utils.isDefined(flags)) {
            flags = "rw";
        }
        if (Utils.isNumber(flags)) {
            intFlags = flags as number;
        } else if (Utils.isString(flags)) {
            if ((flags as string).indexOf("r") >= 0) {
                intFlags |= MEMORY_ACCESS_READ;
            }

            if ((flags as string).indexOf("w") >= 0) {
                intFlags |= MEMORY_ACCESS_WRITE;
            }

            if ((flags as string).indexOf("x") >= 0) {
                intFlags |= MEMORY_ACCESS_EXECUTE;
            }
        }

        if (!Utils.isNumber(intFlags) || intFlags == 0) {
            return;
        }

        return LogicWatchpoint.putWatchpoint(address, intFlags, callback);
    }

    /**
     * A shortcut and secure way to read a string from a pointer with frida on any os
     *
     * ```javascript
     * var what = readString(0x1234);
     * var a = readString(0xabcd, 32);
     * ```
     */
    static readString(address, length?) {
        try {
            address = ptr(address);
            let fstring = "";
            if (!Utils.isNumber(length)) {
                length = -1;
            }
            const range = Process.findRangeByAddress(address);
            if (!Utils.isDefined(range)) {
                return "";
            }
            if (
                Utils.isString(range.protection) &&
                range.protection.indexOf("r") === -1
            ) {
                //Access violation
                return "";
            }
            const _np = new NativePointer(address);
            if (!Utils.isDefined(_np)) {
                return "";
            }
            if (Process.platform === "windows") {
                fstring = _np.readAnsiString(length);
            }
            if (Utils.isString(fstring) && fstring.length === 0) {
                fstring = _np.readCString(length);
            }
            if (Utils.isString(fstring) && fstring.length === 0) {
                fstring = _np.readUtf8String(length);
            }
            if (Utils.isString(fstring) && fstring.length) {
                for (let i = 0; i < fstring.length; i++) {
                    if (!Api.isPrintable(fstring.charCodeAt(i))) {
                        fstring = null;
                        break;
                    }
                }
            }
            if (fstring !== null && Utils.isString(fstring) && fstring.length) {
                return fstring;
            } else {
                return "";
            }
        } catch (e) {
            Utils.logErr("readString", e);
            return "";
        }
    }

    /**
     * A shortcut for safely reading from memory
     *
     * ```javascript
     * var buf = readBytes(0x1234, 32);
     * ```
     */
    static readBytes(address, length) {
        try {
            address = ptr(address);

            // make sure all involved ranges are read-able
            const ranges = [];

            let range;
            let tmp = ptr(address);
            const tail = parseInt(tmp.add(length).toString(), 16);
            while (true) {
                try {
                    range = Process.findRangeByAddress(tmp);
                } catch (e) {
                    break;
                }
                if (range) {
                    if (range.protection[0] !== "r") {
                        Memory.protect(range.base, range.size, "r--");
                        ranges.push(range);
                    }

                    tmp = tmp.add(range.size);
                    if (parseInt(tmp.toString(), 16) >= tail) {
                        break;
                    }
                } else {
                    break;
                }
            }

            const data = ptr(address).readByteArray(length);

            ranges.forEach(range => {
                Memory.protect(range.base, range.size, range.protection);
            });

            return data;
        } catch (e) {
            Utils.logErr("readBytes", e);
            return [];
        }
    }

    /**
     * get a pointer from the given address
     *
     * ```javascript
     * var p = readPointer(0x1234);
     * ```
     */
    static readPointer(pt) {
        try {
            return ptr(pt).readPointer();
        } catch (e) {
            Utils.logErr("readPointer", e);
            return NULL;
        }
    }

    /**
     * resume the execution of the given thread id when in breakpoints
     *
     * ```javascript
     * Interceptor.attach(0x1234, function() {
     *     // do my stuff
     *     releaseFromJs(Process.getCurrentThreadId());
     * });
     * ```
     */
    static releaseFromJs(tid): void {
        Dwarf.loggedSend("release_js:::" + tid);
    }

    /**
     * Remove a breakpoint on address_or_class
     *
     * @return a boolean indicating if removal was successful
     */
    static removeBreakpoint(address_or_class: any): boolean {
        return LogicBreakpoint.removeBreakpoint(address_or_class);
    }

    /**
     * Remove a java class initialization breakpoint on moduleName
     *
     * ```javascript
     * removeJavaClassInitializationBreakpoint('android.app.Activity');
     * ```
     */
    static removeJavaClassInitializationBreakpoint(moduleName: string): boolean {
        const ret = LogicJava.removeModuleInitializationBreakpoint(moduleName);
        if (ret) {
            Dwarf.loggedSend(
                "breakpoint_deleted:::java_class_initialization:::" + moduleName
            );
        }
        return ret;
    }

    /**
     * Remove a module initialization breakpoint on moduleName
     *
     * ```javascript
     * removeModuleInitializationBreakpoint('mytarget.so');
     * ```
     */
    static removeModuleInitializationBreakpoint(moduleName: string): boolean {
        const ret = LogicInitialization.removeModuleInitializationBreakpoint(
            moduleName
        );
        if (ret) {
            Dwarf.loggedSend(
                "breakpoint_deleted:::module_initialization:::" + moduleName
            );
        }
        return ret;
    }

    /**
     * Remove a watchpoint on the given address
     *
     * ```javascript
     * removeWatchpoint(0x1234);
     * ```
     */
    static removeWatchpoint(address: any): boolean {
        return LogicWatchpoint.removeWatchpoint(address);
    }

    /**
     * Restart the application
     * Android only
     *
     * ```javascript
     * restart();
     * ```
     */
    static restart(): boolean {
        if (LogicJava.available) {
            return LogicJava.restartApplication();
        }

        return false;
    }

    private static resume() {
        if (!Dwarf.PROC_RESUMED) {
            Dwarf.PROC_RESUMED = true;
            Dwarf.loggedSend("resume:::0");
        } else {
            console.log("Error: Process already resumed");
        }
    }

    private static setBreakpointCondition(
        address_or_class: any,
        condition?: string | Function
    ): boolean {
        return LogicBreakpoint.setBreakpointCondition(
            address_or_class,
            condition
        );
    }

    /**
     * Send whatever to the data panel
     *
     * ```javascript
     * var sendCount = 0;
     * Interceptor.attach(findExport('send'), function() {
     *     setData(sendCount + '', this.context.x1.readByteArray(parseInt(this.context.x2)))
     *     sendCount++;
     * });
     * ```
     */
    static setData(key, data) {
        if (typeof key !== "string" && key.length < 1) {
            return;
        }

        if (data.constructor.name === "ArrayBuffer") {
            Dwarf.loggedSend("set_data:::" + key, data);
        } else {
            if (typeof data === "object") {
                data = JSON.stringify(data, null, 4);
            }
            Dwarf.loggedSend("set_data:::" + key + ":::" + data);
        }
    }

    /**
     * Start the java tracer on the given classes
     *
     * ```javascript
     * startJavaTracer(['android.app.Activity', 'android.view.View'], function() {
     *     console.log(this.$className, this.method);
     * });
     * ```
     */
    static startJavaTracer(classes: string[], callback: Function | object) {
        return LogicJava.startTrace(classes, callback);
    }

    /**
     * Start the native tracer on the current thread
     *
     * ```javascript
     * startNativeTracer(function() {
     *     log('===============');
     *     log(this.instruction);
     *     log(this.context);
     *     log('===============');
     *     if (shouldStopTracer) {
     *         this.stop();
     *     }
     * });
     *
     *
     * startNativeTracer({
     *      onInstruction: function () {
     *          console.log('onInstruction:', this.instruction.toString());
     *      },
     *      onCall: function () {
     *          console.log('call:', this.instruction.toString());
     *      },
     *      onReturn: function () {
     *          console.log('onReturn:', this.instruction.toString());
     *      },
     *      onJump: function () {
     *          console.log('onJump:', this.instruction.toString());
     *
     *          console.log(JSON.stringify(this.context));
     *          if (this.context.pc.toInt32() === 0xdeadbeef) {
     *              this.stop();
     *          }
     *      },
     *      onPrivilege: function () {
     *          console.log('privilege call:', this.instruction.toString());
     *      }
     * })
     * ```
     */
    static startNativeTracer(callback: Function | NativeTracerCallbacks) {
        const stalkerInfo = LogicStalker.stalk();
        if (stalkerInfo !== null) {
            stalkerInfo.currentMode = callback;
            return true;
        }

        return false;
    }

    /**
     * Stop the java tracer
     *
     * ```javascript
     * stopJavaTracer();
     * ```
     */
    static stopJavaTracer(): boolean {
        return LogicJava.stopTrace();
    }

    /**
     * start syscall tracing
     *
     * strace(function() {
     *     console.log(this.context.x0);
     *     if (1 === 1) {
     *         this.stop();
     *     }
     * });
     */
    static strace(callback): boolean {
        return LogicStalker.strace(callback);
    }

    private static updateModules() {
        const modules = Api.enumerateModules();
        Dwarf.loggedSend(
            "update_modules:::" +
                Process.getCurrentThreadId() +
                ":::" +
                JSON.stringify(modules)
        );
    }

    private static updateRanges() {
        try {
            Dwarf.loggedSend(
                "update_ranges:::" +
                    Process.getCurrentThreadId() +
                    ":::" +
                    JSON.stringify(Process.enumerateRanges("---"))
            );
        } catch (e) {
            Utils.logErr("updateRanges", e);
        }
    }

    private static updateSearchableRanges() {
        try {
            Dwarf.loggedSend(
                "update_searchable_ranges:::" +
                    Process.getCurrentThreadId() +
                    ":::" +
                    JSON.stringify(Process.enumerateRanges("r--"))
            );
        } catch (e) {
            Utils.logErr("updateSearchableRanges", e);
        }
    }

    /**
     * Write the given hex string or ArrayBuffer into the given address
     *
     * ```javascript
     * writeBytes(0x1234, 'aabbccddeeff');
     * ```
     */
    static writeBytes(address: any, what: string | ArrayBuffer) {
        try {
            address = ptr(address);
            if (typeof what === "string") {
                Api.writeUtf8(address, Utils.hex2a(what));
            } else {
                address.writeByteArray(what);
            }
            return true;
        } catch (e) {
            Utils.logErr("writeBytes", e);
            return false;
        }
    }

    private static writeUtf8(address: any, str: any) {
        try {
            address = ptr(address);
            address.writeUtf8String(str);
            return true;
        } catch (e) {
            Utils.logErr("writeUtf8", e);
            return false;
        }
    }
}
