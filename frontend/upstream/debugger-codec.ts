// Generated from DolphinDB VS Code src/debugger/utils.ts (Apache-2.0).
// Rebuild with scripts/sync_debugger.py; see debugger-provenance.json.
import { DdbObj, DdbDict, DdbString, DdbVectorString, DdbVectorInt, DdbVectorAny, DdbInt, DdbBool, DdbForm, DdbType, DdbVoid } from 'dolphindb/browser.js';

/** 基本数据类型到 DdbObj 的转换
    @param value 数字、布尔、字符串 */
export function basictype2ddbobj (value: any): DdbObj {
    if (typeof value === 'string')
        return new DdbString(value)
     else if (typeof value === 'number')
         return new DdbInt(value)
     else if (typeof value === 'boolean')
         return new DdbBool(value)
     else
         return new DdbVoid() as unknown as DdbObj

}

/** 数组转换为DdbVector */
export function array2ddbvector (arr: Array<any>): DdbVectorAny {
    const res: DdbObj[] = [ ]
    // 类型判断，全是数字传VectorInt，服务端说这样方便他们处理
    if (arr.every(item => typeof item === 'string'))
        return new DdbVectorString(arr)
     else if (arr.every(item => typeof item === 'number'))
         return new DdbVectorInt(arr)

    arr.forEach(item => {
        if (Array.isArray(item))
            res.push(array2ddbvector(item))
         else if (typeof item === 'object')
             res.push(json2ddbdict(item))
         else
             res.push(basictype2ddbobj(item))
    })
    return new DdbVectorAny(res)
}

/** json 数据转换为 DdbDict
    @param data 支持嵌套 json、数组、基本数据类型 */
export function json2ddbdict (data: any): DdbDict {
    const keys: string[] = [ ],
        values: DdbObj[] = [ ]

    Object.entries(data).forEach(([key, value]) => {
        keys.push(key)
        if (Array.isArray(value))
            values.push(array2ddbvector(value))
         else if (typeof value === 'object')
             values.push(json2ddbdict(value))
         else
             values.push(basictype2ddbobj(value))

    })

    return new DdbDict(
        new DdbVectorString(keys),
        new DdbObj({
            form: DdbForm.vector,
            type: DdbType.any,
            rows: values.length,
            cols: 1,
            value: DdbObj.to_ddbobjs(values)
        })
    )
}
