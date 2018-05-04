import {
    ObservableMap,
    IMapWillChange,
    action,
    intercept,
    observe,
    values,
    observable,
    _interceptReads,
    IMapDidChange
} from "mobx"
import {
    getStateTreeNode,
    escapeJsonPath,
    IJsonPatch,
    INode,
    createNode,
    isStateTreeNode,
    IStateTreeNode,
    IType,
    IComplexType,
    ComplexType,
    TypeFlags,
    IContext,
    IValidationResult,
    typeCheckFailure,
    flattenTypeErrors,
    getContextForPath,
    typecheck,
    addHiddenFinalProp,
    fail,
    isMutable,
    isPlainObject,
    isType,
    ObjectNode,
    mobxShallow,
    IAnyType
} from "../../internal"
interface IMapFactoryConfig {
    isMapFactory: true
}

export interface IExtendedObservableMap<T> extends ObservableMap<string, T> {
    put(value: T | any): this // downtype to any, again, because we cannot type the snapshot, see
}

export interface IKeyValueMap<T> {
    readonly [key: string]: T
}

export function mapToString(this: ObservableMap<any, any>) {
    return `${getStateTreeNode(this as IStateTreeNode)}(${this.size} items)`
}

const needsIdentifierError = `Map.put can only be used to store complex values that have an identifier type attribute`

function put(this: ObservableMap<any, any>, value: any) {
    if (!!!value) fail(`Map.put cannot be used to set empty values`)
    if (isStateTreeNode(value)) {
        const node = getStateTreeNode(value)
        if (process.env.NODE_ENV !== "production") {
            if (!node.identifierAttribute) return fail(needsIdentifierError)
        }
        this.set("" + node.identifier!, node.value)
        return this
    } else if (!isMutable(value)) {
        return fail(`Map.put can only be used to store complex values`)
    } else {
        const mapType = getStateTreeNode(this as IStateTreeNode).type as MapType<any, any, any>
        if (mapType.identifierMode === MapIdentifierMode.NO) return fail(needsIdentifierError)
        if (mapType.identifierMode === MapIdentifierMode.YES) {
            this.set("" + value[mapType.identifierAttribute!], value)
            return this
        }
        // we don't know the identifier attr yet, so we have to create the instance already to be able to determine
        // luckily, needs to happen only once
        const node = getStateTreeNode(mapType.subType.create(value)) // FIXME: this will unecessarly first create and after that attach.
        if (!node.identifierAttribute) return fail(needsIdentifierError)
        this.set("" + node.value[node.identifierAttribute!], node.value)
        return this
    }
}

export enum MapIdentifierMode {
    UNKNOWN,
    YES,
    NO
}

export class MapType<C, S, T> extends ComplexType<
    IKeyValueMap<C>,
    IKeyValueMap<S>,
    IExtendedObservableMap<T>
> {
    shouldAttachNode = true
    subType: IAnyType
    identifierMode: MapIdentifierMode = MapIdentifierMode.UNKNOWN
    identifierAttribute: string | undefined = undefined
    readonly flags = TypeFlags.Map

    constructor(name: string, subType: IAnyType) {
        super(name)
        this.subType = subType
    }

    instantiate(parent: ObjectNode | null, subpath: string, environment: any, snapshot: S): INode {
        return createNode(
            this,
            parent,
            subpath,
            environment,
            snapshot,
            this.createNewInstance,
            this.finalizeNewInstance
        )
    }

    describe() {
        return "Map<string, " + this.subType.describe() + ">"
    }

    createNewInstance = () => {
        // const identifierAttr = getIdentifierAttribute(this.subType)
        const map = observable.map({}, mobxShallow)
        addHiddenFinalProp(map, "put", put)
        addHiddenFinalProp(map, "toString", mapToString)
        return map
    }

    finalizeNewInstance = (node: INode, snapshot: any) => {
        const objNode = node as ObjectNode
        const instance = objNode.storedValue as ObservableMap<any, any>
        _interceptReads(instance, objNode.unbox)
        intercept(instance, c => this.willChange(c))
        objNode.applySnapshot(snapshot)
        observe(instance, this.didChange)
    }

    getChildren(node: ObjectNode): ReadonlyArray<INode> {
        // return (node.storedValue as ObservableMap<any>).values()
        return values(node.storedValue as ObservableMap<any, any>)
    }

    getChildNode(node: ObjectNode, key: string): INode {
        const childNode = node.storedValue.get("" + key)
        if (!childNode) fail("Not a child " + key)
        return childNode
    }

    willChange(change: IMapWillChange<any, any>): IMapWillChange<any, any> | null {
        const node = getStateTreeNode(change.object as IStateTreeNode)
        const key = "" + change.name
        node.assertWritable()

        switch (change.type) {
            case "update":
                {
                    const { newValue } = change
                    const oldValue = change.object.get(key)
                    if (newValue === oldValue) return null
                    typecheck(this.subType, newValue)
                    change.newValue = this.subType.reconcile(
                        node.getChildNode(key),
                        change.newValue
                    )
                    this.processIdentifier(key, change.newValue as INode)
                }
                break
            case "add":
                {
                    typecheck(this.subType, change.newValue)
                    change.newValue = this.subType.instantiate(
                        node,
                        key,
                        undefined,
                        change.newValue
                    )
                    this.processIdentifier(key, change.newValue as INode)
                }
                break
        }
        return change
    }

    private processIdentifier(expected: string, node: INode) {
        if (node instanceof ObjectNode) {
            // identifier cannot be determined up front, as they might need to go through unions etc
            // but for maps, we do want them to be regular, and consistently used.
            if (this.identifierMode === MapIdentifierMode.UNKNOWN) {
                this.identifierMode =
                    node.identifierAttribute !== undefined
                        ? MapIdentifierMode.YES
                        : MapIdentifierMode.NO
                this.identifierAttribute = node.identifierAttribute
            }
            if (node.identifierAttribute !== this.identifierAttribute)
                // both undefined if type is NO
                fail(
                    `The objects in a map should all have the same identifier attribute, expected '${
                        this.identifierAttribute
                    }', but child of type '${node.type.name}' declared attribute '${
                        node.identifierAttribute
                    }' as identifier`
                )
            if (this.identifierMode === MapIdentifierMode.YES) {
                const identifier = "" + node.identifier! // 'cause snapshots always have their identifiers as strings. blegh..
                if (identifier !== expected)
                    fail(
                        `A map of objects containing an identifier should always store the object under their own identifier. Trying to store key '${identifier}', but expected: '${expected}'`
                    )
            }
        }
    }

    getValue(node: ObjectNode): any {
        return node.storedValue
    }

    getSnapshot(node: ObjectNode): IKeyValueMap<S> {
        const res: any = {}
        node.getChildren().forEach(childNode => {
            res[childNode.subpath] = childNode.snapshot
        })
        return res
    }

    didChange(change: IMapDidChange<any, any>): void {
        const node = getStateTreeNode(change.object as IStateTreeNode)
        switch (change.type) {
            case "update":
                return void node.emitPatch(
                    {
                        op: "replace",
                        path: escapeJsonPath(change.name),
                        value: change.newValue.snapshot,
                        oldValue: change.oldValue ? change.oldValue.snapshot : undefined
                    },
                    node
                )
            case "add":
                return void node.emitPatch(
                    {
                        op: "add",
                        path: escapeJsonPath(change.name),
                        value: change.newValue.snapshot,
                        oldValue: undefined
                    },
                    node
                )
            case "delete":
                // a node got deleted, get the old snapshot and make the node die
                const oldSnapshot = change.oldValue.snapshot
                change.oldValue.die()
                // emit the patch
                return void node.emitPatch(
                    { op: "remove", path: escapeJsonPath(change.name), oldValue: oldSnapshot },
                    node
                )
        }
    }

    applyPatchLocally(node: ObjectNode, subpath: string, patch: IJsonPatch): void {
        const target = node.storedValue as ObservableMap<any, any>
        switch (patch.op) {
            case "add":
            case "replace":
                target.set(subpath, patch.value)
                break
            case "remove":
                target.delete(subpath)
                break
        }
    }

    @action
    applySnapshot(node: ObjectNode, snapshot: any): void {
        typecheck(this, snapshot)
        const target = node.storedValue as ObservableMap<any, any>
        const currentKeys: { [key: string]: boolean } = {}
        Array.from(target.keys()).forEach(key => {
            currentKeys[key] = false
        })
        // Don't use target.replace, as it will throw all existing items first
        for (let key in snapshot) {
            target.set("" + key, snapshot[key])
            currentKeys["" + key] = true
        }
        Object.keys(currentKeys).forEach(key => {
            if (currentKeys[key] === false) target.delete(key)
        })
    }

    getChildType(key: string): IAnyType {
        return this.subType
    }

    isValidSnapshot(value: any, context: IContext): IValidationResult {
        if (!isPlainObject(value)) {
            return typeCheckFailure(context, value, "Value is not a plain object")
        }

        return flattenTypeErrors(
            Object.keys(value).map(path =>
                this.subType.validate(value[path], getContextForPath(context, path, this.subType))
            )
        )
    }

    getDefaultSnapshot() {
        return {}
    }

    removeChild(node: ObjectNode, subpath: string) {
        ;(node.storedValue as ObservableMap<any, any>).delete(subpath)
    }
}

export function map<C, S, T>(
    subtype: IType<C, S, T>
): IComplexType<IKeyValueMap<C>, IKeyValueMap<S>, IExtendedObservableMap<T>>
/**
 * Creates a key based collection type who's children are all of a uniform declared type.
 * If the type stored in a map has an identifier, it is mandatory to store the child under that identifier in the map.
 *
 * This type will always produce [observable maps](https://mobx.js.org/refguide/map.html)
 *
 * @example
 * const Todo = types.model({
 *   id: types.identifier(types.number),
 *   task: types.string
 * })
 *
 * const TodoStore = types.model({
 *   todos: types.map(Todo)
 * })
 *
 * const s = TodoStore.create({ todos: {} })
 * unprotect(s)
 * s.todos.set(17, { task: "Grab coffee", id: 17 })
 * s.todos.put({ task: "Grab cookie", id: 18 }) // put will infer key from the identifier
 * console.log(s.todos.get(17).task) // prints: "Grab coffee"
 *
 * @export
 * @alias types.map
 * @param {IType<S, T>} subtype
 * @returns {IComplexType<S[], IObservableArray<T>>}
 */
export function map<C, S, T>(
    subtype: IType<C, S, T>
): IComplexType<IKeyValueMap<C>, IKeyValueMap<S>, IExtendedObservableMap<T>> {
    return new MapType<C, S, T>(`map<string, ${subtype.name}>`, subtype)
}

export function isMapType<C, S, T>(
    type: any
): type is IComplexType<IKeyValueMap<C>, IKeyValueMap<S>, IExtendedObservableMap<T>> {
    return isType(type) && (type.flags & TypeFlags.Map) > 0
}
