# KOTOR/Aurora Binary Formats and TSLPatcher Reference

All integers are **little-endian** unless stated otherwise (the one exception: NCS bytecode is big-endian, which matters for HACKList). All strings are byte strings; CExoString/labels/resrefs are CP-1252 (KOTOR never uses UTF-8). ResRefs are <=16 bytes, conventionally lowercase, written null-padded to 16 bytes (a 16-char resref has no terminator).

## 1. GFF V3.2 (.utc .uti .utp .utd .ute .utm .uts .utt .utw .dlg .gui .are .git .ifo .jrl .fac .pth .bic)

### Header (56 bytes)

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | FileType, e.g. `"UTC "`, `"DLG "`, `"GFF "` (4 chars, space-padded, uppercase) |
| 4 | 4 | Version `"V3.2"` |
| 8 | u32 | StructOffset |
| 12 | u32 | StructCount |
| 16 | u32 | FieldOffset |
| 20 | u32 | FieldCount |
| 24 | u32 | LabelOffset |
| 28 | u32 | LabelCount |
| 32 | u32 | FieldDataOffset |
| 36 | u32 | FieldDataCount (byte size of the field data block) |
| 40 | u32 | FieldIndicesOffset |
| 44 | u32 | FieldIndicesCount (byte size: 4 x number of indices) |
| 48 | u32 | ListIndicesOffset |
| 52 | u32 | ListIndicesCount (byte size) |

All offsets are from file start. Canonical section order: header, structs, fields, labels, field data, field indices, list indices (readers should use the offsets, not assume order).

### Struct array (12 bytes each)
- `Type` u32: struct id. Root struct (index 0) has type `0xFFFFFFFF`.
- `DataOrDataOffset` u32: if `FieldCount == 1`, this is a field index (into the field array). If `FieldCount > 1`, it is a byte offset into the field indices array where `FieldCount` consecutive u32 field indices live. If `FieldCount == 0`, unused (write 0; tolerate 0xFFFFFFFF).
- `FieldCount` u32.

### Field array (12 bytes each)
- `Type` u32, `LabelIndex` u32 (into label array), `DataOrDataOffset` u32.

### Label array (16 bytes each)
Field name, CP-1252, null-padded to 16 (no terminator if exactly 16). Labels are deduplicated.

### Field type ids and storage

| Id | Name | Storage |
|---|---|---|
| 0 | BYTE (u8) | inline |
| 1 | CHAR (i8) | inline |
| 2 | WORD (u16) | inline |
| 3 | SHORT (i16) | inline |
| 4 | DWORD (u32) | inline |
| 5 | INT (i32) | inline |
| 6 | DWORD64 (u64) | data block, 8 bytes |
| 7 | INT64 (i64) | data block, 8 bytes |
| 8 | FLOAT (f32) | inline (IEEE-754 bits in the 4-byte slot) |
| 9 | DOUBLE (f64) | data block, 8 bytes |
| 10 | CExoString | data block: u32 length, then bytes (no terminator) |
| 11 | ResRef | data block: u8 length, then bytes (<=16) |
| 12 | CExoLocString | data block (see below) |
| 13 | VOID | data block: u32 length, then raw bytes |
| 14 | Struct | `DataOrDataOffset` = struct index into struct array |
| 15 | List | `DataOrDataOffset` = byte offset into list indices array |
| 16 | Orientation (KOTOR; quaternion) | data block: 4 x f32 (x, y, z, w), 16 bytes |
| 17 | Vector (KOTOR; position) | data block: 3 x f32 (x, y, z), 12 bytes |
| 18 | StrRef (KOTOR) | data block: u32 size (=4), then u32 strref. Rare. |

Inline values occupy the low bytes of the 4-byte `DataOrDataOffset`; unused high bytes are zero. Data-block offsets are relative to `FieldDataOffset`.

CExoLocString in the data block:
```
u32 TotalSize      // byte count of everything after this field: 8 + sum(8 + len)
u32 StringRef      // 0xFFFFFFFF (-1) = none
u32 StringCount
repeat StringCount:
  u32 StringID     // = LanguageID*2 + Gender (gender 0 = male/neutral, 1 = female)
  u32 Length
  bytes[Length]
```
Language ids: 0 English, 1 French, 2 German, 3 Italian, 4 Spanish, 5 Polish, 128 Korean, 129 Chinese Trad., 130 Chinese Simp., 131 Japanese.

List in the list indices array: at the field's offset: `u32 Count`, then `Count` x u32 struct indices. Empty list = a single `u32 0` (still consumes 4 bytes; every List field gets its own entry).

### Reading
Read header; read struct 0 recursively: get its field indices (single vs. via field-indices array), for each field read type/label/data; for Struct fields recurse; for List fields read count + indices and recurse into each.

### Writing
Walk the tree depth-first from the root, allocating struct indices in visitation order (root = 0). For each struct: record its fields; for each field allocate a field index and label index (dedup labels by name). Simple types inline. Complex types append encoded bytes to a field-data buffer and store the offset. Struct fields: allocate the child struct index and store it. List fields: append `count` + child struct indices to the list-indices buffer and store that offset. Structs with >1 field append their field indices to the field-indices buffer and store that offset. Compute section offsets (56 + 12*S, + 12*F, + 16*L, + data, + fieldIdx, + listIdx) and write header + sections. No alignment required.

## 2. 2DA V2.b

```
"2DA V2.b\n"                       // 9 bytes
column labels: each label followed by '\t', list terminated by a single '\0'
u32 RowCount
row labels: each followed by '\t'   (count = RowCount)
u16 CellOffset[RowCount * ColumnCount]  // row-major, relative to start of the data block
u16 DataSize                        // total byte size of the data block
data block: null-terminated strings
```
- Row labels are conventionally "0".."N-1" but arbitrary strings.
- Offsets are u16 so the data block must be <= 65535 bytes. Writers deduplicate identical cell strings; the empty string is written once as a single `\0`.
- `****` is the convention for "no value" and is stored verbatim.
- Column labels matched case-insensitively by TSLPatcher.

## 3. TLK V3.0 (dialog.tlk)

Header (20 bytes): `"TLK "`, `"V3.0"`, u32 LanguageID, u32 StringCount, u32 StringEntriesOffset (= 20 + 40*StringCount).

Entry table at offset 20, 40 bytes each:

| Off | Type | Field |
|---|---|---|
| 0 | u32 | Flags: bit0 TEXT_PRESENT (0x1), bit1 SND_PRESENT (0x2), bit2 SNDLENGTH_PRESENT (0x4) |
| 4 | 16 | SoundResRef, null-padded |
| 20 | u32 | VolumeVariance (0) |
| 24 | u32 | PitchVariance (0) |
| 28 | u32 | OffsetToString, relative to StringEntriesOffset |
| 32 | u32 | StringSize (bytes, no terminator) |
| 36 | f32 | SoundLength (write 0.0) |

String data follows. Encoding per LanguageID: cp1252 for 0-4, cp1250 Polish, cp949 Korean, cp950 Trad. Chinese, cp936 Simp. Chinese, cp932 Japanese. The TypeScript codec supports all listed Windows code pages and rejects unknown languages or text that cannot be encoded without loss. Entry index = StrRef. Write `flags = 1 | (sound?2:0) | (sound?4:0)`. StrRef -1 / 0xFFFFFFFF = none. Append operations add entries at index StringCount.

## 4. SSF V1.1 (KOTOR soundset)

```
0   "SSF "
4   "V1.1"
8   u32 OffsetToEntries   (= 12)
12  u32 StrRef[28]        (0xFFFFFFFF = unset)
```
Total 124 bytes; PyKotor pads to 40 entries (172 bytes); readers read 28.

Entry order: 0-5 Battlecry 1-6; 6-8 Selected 1-3; 9-11 Attack 1-3; 12-13 Pain 1-2; 14 Low health; 15 Death; 16 Critical hit; 17 Target immune; 18 Place mine; 19 Disarm mine; 20 Stealth on; 21 Search; 22 Pick lock start; 23 Pick lock fail; 24 Pick lock done; 25 Leave party; 26 Rejoin party; 27 Poisoned.

## 5. ERF / MOD / SAV / HAK (V1.0) and RIM (V1.0)

### ERF header (160 bytes)

| Off | Type | Field |
|---|---|---|
| 0 | 4 | FileType: "ERF ", "MOD ", "SAV ", "HAK " |
| 4 | 4 | "V1.0" |
| 8 | u32 | LanguageCount (0) |
| 12 | u32 | LocalizedStringSize (0) |
| 16 | u32 | EntryCount |
| 20 | u32 | OffsetToLocalizedStrings (=160) |
| 24 | u32 | OffsetToKeyList (=160 + LocalizedStringSize) |
| 28 | u32 | OffsetToResourceList (= OffsetToKeyList + 24*EntryCount) |
| 32 | u32 | BuildYear (years since 1900) |
| 36 | u32 | BuildDay |
| 40 | u32 | DescriptionStrRef (0xFFFFFFFF if none) |
| 44 | 116 | reserved zeros |

Key list, 24 bytes each: `char ResRef[16]`, `u32 ResID` (= index), `u16 ResType`, `u16 Unused`.
Resource list, 8 bytes each: `u32 OffsetToResource`, `u32 ResourceSize`. Data follows, packed in order.

### RIM header (120 bytes)
`"RIM "`, `"V1.0"`, u32 reserved, u32 EntryCount, u32 OffsetToEntries (=120), 100 reserved bytes.
Entries, 32 bytes each: `char ResRef[16]`, `u32 ResType`, `u32 ResID`, `u32 Offset`, `u32 Size`.

## 6. Resource type ids

| Ext | Id | Ext | Id | Ext | Id |
|---|---|---|---|---|---|
| res | 0 | bmp | 1 | tga | 3 |
| wav | 4 | plt | 6 | ini | 7 |
| txt | 10 | mdl | 2002 | nss | 2009 |
| ncs | 2010 | mod | 2011 | are | 2012 |
| set | 2013 | ifo | 2014 | bic | 2015 |
| wok | 2016 | 2da | 2017 | tlk | 2018 |
| txi | 2022 | git | 2023 | bti | 2024 |
| uti | 2025 | btc | 2026 | utc | 2027 |
| dlg | 2029 | itp | 2030 | btt | 2031 |
| utt | 2032 | dds | 2033 | uts | 2035 |
| ltr | 2036 | gff | 2037 | fac | 2038 |
| bte | 2039 | ute | 2040 | btd | 2041 |
| utd | 2042 | btp | 2043 | utp | 2044 |
| dft | 2045 | gic | 2046 | gui | 2047 |
| btm | 2050 | utm | 2051 | dwk | 2052 |
| pwk | 2053 | jrl | 2056 | sav | 2057 |
| utw | 2058 | 4pc | 2059 | ssf | 2060 |
| hak | 2061 | nwm | 2062 | bik | 2063 |
| ndb | 2064 | ptm | 2065 | ptt | 2066 |
| lyt | 3000 | vis | 3001 | rim | 3002 |
| pth | 3003 | lip | 3004 | tpc | 3007 |
| mdx | 3008 | cwa | 3027 | bip | 3028 |
| erf | 9997 | bif | 9998 | key | 9999 |
| mp3 | 25014 | png | 2110 | jpg | 2076 |

## 7. TSLPatcher changes.ini

INI conventions: sections `[Name]`, `Key=Value`, `;` comments. Keys are case-insensitive. Sections are processed in this fixed order regardless of file position: [Settings] -> [TLKList] -> [InstallList] -> [2DAList] -> [GFFList] -> [CompileList] -> [HACKList] -> [SSFList]. Files are loaded from `tslpatchdata` (or `!SourceFolder`), patched, and written to the destination, defaulting to `Override`. A file already present in the game's destination is patched from the game copy (2DA/GFF/SSF lists modify existing files in place); only InstallList/CompileList copy new files.

Two token pools persist across sections: `StrRef<N>` (TLK memory: N -> dialog.tlk index) and `2DAMEMORY<N>` (2DA memory: N -> string, usually a row index; can also hold a GFF field path via `!FieldPath`). Any value field in later sections may be the literal token name (`StrRef5`, `2DAMEMORY3`) and is substituted; using an undefined token is an error.

In a GFF section `2DAMEMORY<N>=2DAMEMORY<M>` copies token M into token N; if N currently holds a stored field path (`!FieldPath`) the value of M (dereferenced when M is a field path too) is written into that field instead. `2DAMEMORY<N>=<value>` (any other value) writes `<value>` to the field whose path is stored in N. In a 2DA row section `2DAMEMORY<N>=2DAMEMORY<M>`/`StrRef<M>` copies the token value.

### [Settings]
`WindowCaption`, `ConfirmMessage`, `LogLevel` (0 none, 1 errors, 2 general, 3 warnings, 4 verbose), `InstallerMode`, `BackupFiles`, `PlaintextLog`, `LookupGameFolder`, `LookupGameNumber` (1 KOTOR, 2 TSL), `SaveProcessedScripts`, `Required`/`Required<N>` (comma list of files that must exist in Override) with `RequiredMsg`/`RequiredMsg<N>`, `FileExists`, `IgnoreExtensions`.

### [TLKList]
- `StrRef<N>=<M>`: take entry M from `append.tlk` (in tslpatchdata; override with `!SourceFile=other.tlk`), append it to dialog.tlk, and store the resulting dialog.tlk index in token `StrRef<N>`.
- `Replace<N>=<section>` / `ReplaceFile<N>` / `AppendFile<N>=<section>`: the referenced section maps `dialog_index=append_index`; `Replace` overwrites existing dialog.tlk entries.
- HoloPatcher-only: `StrRef<N>/Text=...`, `StrRef<N>/Sound=resref`; `!DefaultDestination`, `!DefaultSourceFolder`.

### [InstallList]
```
[InstallList]
install_folder0=Override
install_folder1=Modules
[install_folder0]
File0=foo.uti          ; copy only if not present (warn and skip otherwise)
Replace0=bar.utc       ; overwrite
```
The files of `install_folder<N>` are listed in the section named by the key (`[install_folder<N>]`); the value is the destination. A section named after the value is accepted as a fallback. Folder values are paths relative to the game dir. If the destination is an archive path (`Modules\danm13.mod`, `.rim`, `.erf`, `.sav`) the file is inserted into that archive (Replace overwriting an existing entry). Optional per-file section `[foo.uti]`: `!SourceFolder`, `!SaveAs`/`!Filename`, `!Destination`, `!ReplaceFile`. `!OverrideType` (`ignore` default | `warn` | `rename`): what to do if a file being installed into a module also exists in Override; rename renames the Override copy to `.bak`.

### [2DAList]
The key of a list entry is an opaque identifier (`Table<N>`, `File<N>`, `Replace<N>`, ...; entries are processed in INI file order, never re-sorted by their numeric suffix, and a key starting with `Replace` replaces); the value is the file name. The same holds for every file list ([InstallList] file sections, [GFFList], [CompileList], [HACKList], [SSFList]). Only the `[TLKList]` entries and the `install_folder<N>` keys of `[InstallList]` are ordered by numeric suffix.
```
[2DAList]
Table0=spells.2da
[spells.2da]
AddRow0=spells_new_row
ChangeRow0=spells_fix
CopyRow0=spells_copy
AddColumn0=spells_col
[spells_new_row]
ExclusiveColumn=label      ; if a row with this column == our value exists, ChangeRow it instead
RowLabel=1234              ; label for the new row (default = new row index)
label=my_spell
name=StrRef0
spellicon=****             ; write empty cell
forbiditemmask=high()      ; max numeric value in column + 1
2DAMEMORY0=RowIndex        ; store new row's index in token
```
- Target selectors (ChangeRow/CopyRow, one required): `RowIndex=<int>`, `RowLabel=<label>`, `LabelIndex=<value>` (matches the `label` column). Values may be `2DAMEMORY#`.
- `NewRowLabel=` (CopyRow/AddRow) label for the copy.
- Cell values: literal, `****` (empty), `StrRef#`, `2DAMEMORY#`, `high()`.
- Memory stores: `2DAMEMORY#=RowIndex` | `RowLabel` | `<column name>`.
- `AddColumn`: `ColumnLabel=name`, `DefaultValue=****` (or text), `I<rowIndex>=value`, `L<rowLabel>=value`, `2DAMEMORY#=I<idx>` / `L<label>`.
- No DeleteRow. Modifiers (`AddRow`/`ChangeRow`/`CopyRow`/`AddColumn`, and `AddField` in [GFFList]) execute in INI file order across all prefixes, as TSLPatcher/HoloPatcher do: `AddRow0`, `AddRow1`, `ChangeRow0` run in that order, so a `ChangeRow` can read a `2DAMEMORY#` stored by a later-numbered `AddRow` listed before it. Within one row section, `RowIndex`/`RowLabel`/token-copy stores run at their key position (a later cell may read them); stores of a column's content run after all cells are written.

### [GFFList]
```
[GFFList]
File0=p_bastilla.utc
[p_bastilla.utc]
!Destination=Override        ; or Modules\danm13.mod
!ReplaceFile=0               ; 1 = copy from tslpatchdata over existing; 0 = patch the game copy
!SaveAs=newname.utc          ; (!Filename alias)
!OverrideType=warn
FirstName(strref)=StrRef3    ; set LocString's strref
FirstName(lang0)=Bastila     ; set substring id 0
ClassList/0/Class=5          ; path modify: labels separated by '/', list elements by index
AddField0=add_feat
2DAMEMORY4=!FieldPath
2DAMEMORY6=2DAMEMORY4        ; copy token / write token value into the field stored in 6
[add_feat]
FieldType=Struct
Path=FeatList                ; parent (empty = root). For a List parent, the struct is appended
Label=
TypeId=1                     ; or ListIndex: the struct's type id is its index in the list
2DAMEMORY5=ListIndex
AddField0=add_feat_id
[add_feat_id]
FieldType=Word
Path=FeatList/>>##INDEXINLIST##<<   ; internal; in ini you just nest AddField
Label=Feat
Value=2DAMEMORY0
```
- `FieldType` names: Byte(0) Char(1) Word(2) Short(3) DWORD(4) Int(5) Int64(7) Float(8) Double(9) ExoString(10) ResRef(11) ExoLocString(12) Position(17) Orientation(16) Struct(14) List(15); Binary(13); numeric ids accepted.
- `Value=` parsing: ints/floats; vectors use `|` separator; strings verbatim; ExoLocString uses `StrRef=<n|StrRef#>` plus `lang<id>=text` keys. Nested `AddField<N>=` inside an AddField section add children.
- If the field already exists at Path/Label, AddField modifies it instead.
- Path elements matched case-sensitively; list children by 0-based integer.

### [CompileList]
`File0=myscript.nss`, optional `[myscript.nss]` with `!Destination`, `!SaveAs`, `!ReplaceFile`, `!SourceFolder`. Placeholders `#2DAMEMORY1#` and `#StrRef1#` substituted, then compiled with `nwnnsscomp.exe`. The native TypeScript implementation uses a precompiled `.ncs` from tslpatchdata when present. Missing precompiled files and source placeholders that require recompilation produce an error, so incomplete script installation cannot report success. A native compiler is not bundled, but `TslPatcherOptions.compileScript` accepts an optional external compiler hook (see below).

##### External compiler hook

When tslpatchdata has no precompiled `.ncs` for a script and `compileScript` is set, the engine substitutes the `#2DAMEMORY#`/`#StrRef#` placeholders in the `.nss`, encodes it as windows-1252 and passes it to the hook (`{ name, source, game, includeDirs, readGameResource }`); the returned `.ncs` bytes go through the normal write path (`!Destination`, `!SaveAs`, `!ReplaceFile`, backups). A shipped precompiled `.ncs` still wins, a dry run still records the script as unverified without calling the hook, and without a hook the behavior is unchanged. `game` comes from `TslPatcherOptions.game`, else 2 when `swkotor2.exe`/`swkotor2.ini` is in the game directory, else 1. `readGameResource(name)` reads a file from `Override`, then from the base game's `chitin.key`/BIF archives.

`@modsync/core`'s native patcher builds the hook from the environment (`packages/core/src/engine/nssCompiler.ts`):

| Variable | Meaning |
| --- | --- |
| `MODSYNC_NSS_COMPILER` | Path of a command line compiler. Unset or blank disables the hook. A path ending in `.exe` is launched through `wine` outside Windows. |
| `MODSYNC_NSS_GAME` | `1`/`k1`/`kotor1` or `2`/`k2`/`kotor2`/`tsl`. Default: detected from the game directory (`swkotor2.exe` etc.); the engine falls back to 1 if undetectable. |

The compiler is run in a fresh temp directory as `<compiler> -c <name>.nss -o <name>.ncs -g <1|2> -n nwscript.nss -i <tslpatchdata dir> -i <temp dir>` (the flags of `bionsscomp`, `-g`/`-n`/`-i`/`-o`/`-c`). The substituted source and the game's `nwscript.nss` are written to the temp dir first; `nwscript.nss` is read from `Override`, then the BIFs, and compilation fails if it is not found. `#include "<name>"` scripts are resolved recursively: a copy next to the mod (case-insensitive) is used as is, otherwise the script (e.g. `k_inc_*`) is extracted from `Override` or the BIFs into the temp dir. Includes found nowhere are left for the compiler to report. The compiler needs a physical `tslpatchdata` directory; a non-zero exit, a missing `.ncs` or an empty `.ncs` fails that `[CompileList]` entry with the compiler's output. The temp dir is always removed.

Limitations: only `#include "<bare name>"` forms are staged (no path separators), and a script that already has a precompiled `.ncs` is never recompiled, so sources with placeholders next to a precompiled `.ncs` still fail as before.

### [HACKList]
`File0=script.ncs`, `[script.ncs]`: `!Destination`, `!ReplaceFile`, `!SaveAs`, and `<byteOffset>=<value>` lines. Offset decimal (or 0x hex); value literal integer or `StrRef#`/`2DAMEMORY#`, written as unsigned 16-bit big-endian at that offset.

### [SSFList]
`File0=p_bastilla.ssf`, `[p_bastilla.ssf]`: `!Destination`, `!ReplaceFile`, `!SaveAs`, then `<sound name>=<value>` using the 28 names from section 4, value = integer strref, `StrRef#`, or `2DAMEMORY#`.

### namespaces.ini
```
[Namespaces]
Namespace0=option_a
Namespace1=option_b
[option_a]
Name=Full install
Description=Installs everything
IniName=changes.ini
InfoName=info.rtf
DataFolderName=tslpatchdata
```
If absent, or present without a `[Namespaces]` section or any `Namespace<N>` entries, use `tslpatchdata/changes.ini` and `tslpatchdata/info.rtf`. A listed entry whose section is missing is a malformed file and is an error.

## 8. Backup / uninstall conventions

Before overwriting or inserting into any file, the original is copied to `<modroot>/backup/<YYYY-MM-DD_HH.MM.SS>/`, preserving the relative game path. Files that did not exist before are recorded in `backup/<ts>/remove these files.txt` (newline-separated absolute paths). Reverting means deleting listed files then copying every other file in the backup folder back to the game dir. `installlog.txt` written to the mod root. Backups are per-file-first-touch.
