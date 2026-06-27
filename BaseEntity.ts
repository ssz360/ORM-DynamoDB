import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
    PutCommand,
    GetCommand,
    UpdateCommand,
    DeleteCommand,
    QueryCommand
} from '@aws-sdk/lib-dynamodb';
import { LINKS_METADATA, TO_DB_MODEL_METADATA, FROM_DB_MODEL_METADATA } from './symbols';
import type { LinkMetadata, QueryOptions, EntityMetadata } from './types';
import { configureClient, getDocClient, paginatedQuery, encodeLinkSegment } from './client';

type QueryHelperOptions = Omit<QueryOptions, 'sortKeyCondition'>;

export class BaseEntity {

    protected getMetadata(): EntityMetadata {
        return (this.constructor as any).__entityMetadata__;
    }

    protected getKey(source: any = this) {
        const metadata = this.getMetadata();
        const key: any = {};

        if (metadata.hashKeyGetter) {
            key[metadata.hashKeyName] = source[metadata.hashKeyGetter];
        }

        if (metadata.sortKeyName && metadata.sortKeyGetter) {
            key[metadata.sortKeyName] = source[metadata.sortKeyGetter];
        }

        return key;
    }

    protected toItem(source: any = this) {
        const metadata = this.getMetadata();
        const key = this.getKey(source);

        // @ToDbModel is a full serializer: when present, its return value is the
        // complete user-controlled DB shape. Keys and link metadata are added by the ORM.
        const toDbModelMapper = (this.constructor as any)[TO_DB_MODEL_METADATA];
        const item: any = toDbModelMapper
            ? { ...(this.constructor as any)[toDbModelMapper](source) }
            : { ...source };

        // Handle linked entities
        const links: LinkMetadata[] = (this.constructor.prototype as any)[LINKS_METADATA] || [];
        for (const link of links) {
            const value = source[link.propertyKey];
            const isInline = link.inline ?? false;

            if (isInline) {
                if (value !== undefined && value !== null) {
                    if (link.isArray) {
                        item[`__${link.propertyKey}ID`] = (value as BaseEntity[]).map((linkedItem: BaseEntity) => {
                            const linkedKey = linkedItem.getKey();
                            const linkedMetadata = linkedItem.getMetadata();
                            const result: any = {
                                [linkedMetadata.hashKeyName]: linkedKey[linkedMetadata.hashKeyName]
                            };
                            if (linkedMetadata.sortKeyName) {
                                result[linkedMetadata.sortKeyName] = linkedKey[linkedMetadata.sortKeyName];
                            }
                            return result;
                        });
                    } else {
                        const linkedItem = value as BaseEntity;
                        const linkedKey = linkedItem.getKey();
                        const linkedMetadata = linkedItem.getMetadata();
                        const result: any = {
                            [linkedMetadata.hashKeyName]: linkedKey[linkedMetadata.hashKeyName]
                        };
                        if (linkedMetadata.sortKeyName) {
                            result[linkedMetadata.sortKeyName] = linkedKey[linkedMetadata.sortKeyName];
                        }
                        item[`__${link.propertyKey}ID`] = result;
                    }
                }
            } else {
                // Non-inline: ensure no stale __propertyID from a previous loadLinks() is persisted
                delete item[`__${link.propertyKey}ID`];
            }
            // Remove the actual linked entity instances from being saved
            delete item[link.propertyKey];
        }

        return {
            ...item,
            ...key
        };
    }

    protected fromItem<T extends BaseEntity>(this: T, item: any): T {
        const fromDbModelMapper = (this.constructor as any)[FROM_DB_MODEL_METADATA];
        const itemData = fromDbModelMapper
            ? (this.constructor as any)[fromDbModelMapper](item)
            : item;

        Object.assign(this, itemData);
        return this;
    }

    async insert(cascadeSave: boolean = false) {
        const metadata = this.getMetadata();

        // Save linked entities first (cascade save) only if cascadeSave is true
        if (cascadeSave) {
            const links: LinkMetadata[] = (this.constructor.prototype as any)[LINKS_METADATA] || [];
            for (const link of links) {
                const value = (this as any)[link.propertyKey];
                if (value !== undefined && value !== null) {
                    if (Array.isArray(value)) {
                        // Save all linked entities in parallel
                        await Promise.all(value.map((linkedItem: BaseEntity) => linkedItem.insert(true)));
                    } else {
                        // Save single linked entity
                        await (value as BaseEntity).insert(true);
                    }
                }
            }
        }

        const item = this.toItem();

        await getDocClient().send(new PutCommand({
            TableName: metadata.tableName,
            Item: item
        }));

        // Write separate link records for non-inline links.
        // Record shape: { [hashKey]: '__link', [sortKey]: '{parentHK}#{parentSK}#{property}#{linkedHK}#{linkedSK}',
        //                 linkedHashKey, linkedSortKey, isArray }
        // Requires the parent entity table to have a sort key.
        const links: LinkMetadata[] = (this.constructor.prototype as any)[LINKS_METADATA] || [];
        const nonInlineLinks = links.filter(link => {
            const isInline = link.inline ?? false;
            return !isInline;
        });

        if (nonInlineLinks.length > 0 && !metadata.sortKeyName) {
            throw new Error(
                `Entity "${metadata.tableName}" has non-inline @Link properties ` +
                `(${nonInlineLinks.map(l => l.propertyKey).join(', ')}) but no sort key. ` +
                `Non-inline links require a sort key. Use @Link(..., { inline: true }) or add a sort key.`
            );
        }

        if (metadata.sortKeyName && nonInlineLinks.length > 0) {
            const parentKey = this.getKey();
            const parentHKVal = String(parentKey[metadata.hashKeyName]);
            const parentSKVal = String(parentKey[metadata.sortKeyName]);

            for (const link of nonInlineLinks) {
                const value = (this as any)[link.propertyKey];

                // Delete all existing link records for this property before writing new ones.
                // Runs even when value is null/undefined so clearing a link removes stale records.
                const skPrefix = `${encodeLinkSegment(parentHKVal)}#${encodeLinkSegment(parentSKVal)}#${encodeLinkSegment(link.propertyKey)}#`;
                const existingItems = await paginatedQuery({
                    TableName: metadata.tableName,
                    KeyConditionExpression: '#pk = :pkval AND begins_with(#sk, :skprefix)',
                    ExpressionAttributeNames: {
                        '#pk': metadata.hashKeyName,
                        '#sk': metadata.sortKeyName!
                    },
                    ExpressionAttributeValues: {
                        ':pkval': '__link',
                        ':skprefix': skPrefix
                    }
                });
                if (existingItems.length > 0) {
                    const linkedEntityMetadata = (link.entityClass as any).__entityMetadata__;
                    await Promise.all(existingItems.map(async (rec: any) => {
                        await getDocClient().send(new DeleteCommand({
                            TableName: metadata.tableName,
                            Key: {
                                [metadata.hashKeyName]: rec[metadata.hashKeyName],
                                [metadata.sortKeyName!]: rec[metadata.sortKeyName!]
                            }
                        }));
                        // Delete corresponding back-reference from child's table
                        if (linkedEntityMetadata.sortKeyName) {
                            await getDocClient().send(new DeleteCommand({
                                TableName: linkedEntityMetadata.tableName,
                                Key: {
                                    [linkedEntityMetadata.hashKeyName]: '__backlink',
                                    [linkedEntityMetadata.sortKeyName]: `${encodeLinkSegment(rec.linkedHashKey)}#${encodeLinkSegment(rec.linkedSortKey)}#${encodeLinkSegment(metadata.tableName!)}#${encodeLinkSegment(parentHKVal)}#${encodeLinkSegment(parentSKVal)}#${encodeLinkSegment(link.propertyKey)}`
                                }
                            }));
                        }
                    }));
                }

                if (value == null) continue;

                const linkedItems: BaseEntity[] = link.isArray ? value : [value];
                await Promise.all(linkedItems.map(async (linkedItem: BaseEntity) => {
                    const linkedKey = linkedItem.getKey();
                    const linkedMeta = linkedItem.getMetadata();
                    const linkedHKVal = String(linkedKey[linkedMeta.hashKeyName]);
                    const linkedSKVal = linkedMeta.sortKeyName
                        ? String(linkedKey[linkedMeta.sortKeyName])
                        : '';

                    const linkRecord: any = {
                        [metadata.hashKeyName]: '__link',
                        [metadata.sortKeyName!]: `${encodeLinkSegment(parentHKVal)}#${encodeLinkSegment(parentSKVal)}#${encodeLinkSegment(link.propertyKey)}#${encodeLinkSegment(linkedHKVal)}#${encodeLinkSegment(linkedSKVal)}`,
                        linkedHashKey: linkedHKVal,
                        linkedSortKey: linkedSKVal,
                        isArray: link.isArray
                    };

                    await getDocClient().send(new PutCommand({
                        TableName: metadata.tableName,
                        Item: linkRecord
                    }));

                    // Write back-reference in child's table so child deletions can clean up this forward link.
                    if (linkedMeta.sortKeyName) {
                        await getDocClient().send(new PutCommand({
                            TableName: linkedMeta.tableName,
                            Item: {
                                [linkedMeta.hashKeyName]: '__backlink',
                                [linkedMeta.sortKeyName]: `${encodeLinkSegment(linkedHKVal)}#${encodeLinkSegment(linkedSKVal)}#${encodeLinkSegment(metadata.tableName!)}#${encodeLinkSegment(parentHKVal)}#${encodeLinkSegment(parentSKVal)}#${encodeLinkSegment(link.propertyKey)}`,
                                parentTableName: metadata.tableName,
                                parentHashKeyName: metadata.hashKeyName,
                                parentSortKeyName: metadata.sortKeyName,
                                parentHashKey: parentHKVal,
                                parentSortKey: parentSKVal,
                                propertyKey: link.propertyKey
                            }
                        }));
                    }
                }));
            }
        }

        return this;
    }

    async update(attributes: Partial<this>) {
        const metadata = this.getMetadata();
        const key = this.getKey();

        const toDbModelMapper = (this.constructor as any)[TO_DB_MODEL_METADATA];
        if (toDbModelMapper) {
            const snapshot = Object.assign(Object.create(Object.getPrototypeOf(this)), this, attributes);
            await getDocClient().send(new PutCommand({
                TableName: metadata.tableName,
                Item: this.toItem(snapshot)
            }));

            Object.assign(this, attributes);
            return this;
        }

        const updateExpressions: string[] = [];
        const expressionAttributeNames: any = {};
        const expressionAttributeValues: any = {};

        let index = 0;
        for (const [attrName, attrValue] of Object.entries(attributes)) {
            updateExpressions.push(`#attr${index} = :val${index}`);
            expressionAttributeNames[`#attr${index}`] = attrName;
            expressionAttributeValues[`:val${index}`] = attrValue;
            index++;
        }

        await getDocClient().send(new UpdateCommand({
            TableName: metadata.tableName,
            Key: key,
            UpdateExpression: `SET ${updateExpressions.join(', ')}`,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues
        }));

        Object.assign(this, attributes);

        return this;
    }

    async delete() {
        const metadata = this.getMetadata();
        const key = this.getKey();

        // Guard: refuse deletion if other entities still reference this one via backlinks.
        if (metadata.sortKeyName) {
            const itemHKVal = String(key[metadata.hashKeyName]);
            const itemSKVal = String(key[metadata.sortKeyName]);
            const backlinkPrefix = `${encodeLinkSegment(itemHKVal)}#${encodeLinkSegment(itemSKVal)}#`;

            const inboundBacklinks = await paginatedQuery({
                TableName: metadata.tableName,
                KeyConditionExpression: '#pk = :pkval AND begins_with(#sk, :skprefix)',
                ExpressionAttributeNames: { '#pk': metadata.hashKeyName, '#sk': metadata.sortKeyName },
                ExpressionAttributeValues: {
                    ':pkval': '__backlink',
                    ':skprefix': backlinkPrefix
                }
            });

            if (inboundBacklinks.length > 0) {
                throw new Error(
                    `Cannot delete: still referenced by ${inboundBacklinks.length} record(s). Remove all references first.`
                );
            }
        }

        // Clean up non-inline link records before deleting the parent to prevent orphans.
        if (metadata.sortKeyName) {
            const links: LinkMetadata[] = (this.constructor.prototype as any)[LINKS_METADATA] || [];
            const parentHKVal = String(key[metadata.hashKeyName]);
            const parentSKVal = String(key[metadata.sortKeyName]);

            for (const link of links) {
                const isInline = link.inline ?? false;
                if (isInline) continue;

                const existingItems = await paginatedQuery({
                    TableName: metadata.tableName,
                    KeyConditionExpression: '#pk = :pkval AND begins_with(#sk, :skprefix)',
                    ExpressionAttributeNames: { '#pk': metadata.hashKeyName, '#sk': metadata.sortKeyName },
                    ExpressionAttributeValues: {
                        ':pkval': '__link',
                        ':skprefix': `${encodeLinkSegment(parentHKVal)}#${encodeLinkSegment(parentSKVal)}#${encodeLinkSegment(link.propertyKey)}#`
                    }
                });
                const linkedEntityMetadata = (link.entityClass as any).__entityMetadata__;
                await Promise.all(existingItems.map(async (rec: any) => {
                    await getDocClient().send(new DeleteCommand({
                        TableName: metadata.tableName,
                        Key: {
                            [metadata.hashKeyName]: rec[metadata.hashKeyName],
                            [metadata.sortKeyName!]: rec[metadata.sortKeyName!]
                        }
                    }));
                    // Delete corresponding back-reference from child's table
                    if (linkedEntityMetadata.sortKeyName) {
                        await getDocClient().send(new DeleteCommand({
                            TableName: linkedEntityMetadata.tableName,
                            Key: {
                                [linkedEntityMetadata.hashKeyName]: '__backlink',
                                [linkedEntityMetadata.sortKeyName]: `${encodeLinkSegment(rec.linkedHashKey)}#${encodeLinkSegment(rec.linkedSortKey)}#${encodeLinkSegment(metadata.tableName!)}#${encodeLinkSegment(parentHKVal)}#${encodeLinkSegment(parentSKVal)}#${encodeLinkSegment(link.propertyKey)}`
                            }
                        }));
                    }
                }));
            }
        }

        await getDocClient().send(new DeleteCommand({
            TableName: metadata.tableName,
            Key: key
        }));
    }

    async loadLinks() {
        const parentMetadata = this.getMetadata();
        const parentKey = this.getKey();
        const links: LinkMetadata[] = (this.constructor.prototype as any)[LINKS_METADATA] || [];

        for (const link of links) {
            if (!link.entityClass) continue;

            const EntityClass = link.entityClass;
            const entityMetadata = (EntityClass as any).__entityMetadata__;

            const instantiate = (raw: any): BaseEntity => {
                const instance = new EntityClass();
                return instance.fromItem(raw);
            };

            const idField = `__${link.propertyKey}ID`;
            const idValue = (this as any)[idField];

            if (idValue != null) {
                // ── Inline path: IDs embedded on the parent item ──
                if (Array.isArray(idValue)) {
                    const loaded = await Promise.all(
                        idValue.map(async (keyObj: any) => {
                            const result = await getDocClient().send(new GetCommand({
                                TableName: entityMetadata.tableName,
                                Key: keyObj
                            }));
                            return result.Item ? instantiate(result.Item) : null;
                        })
                    );
                    (this as any)[link.propertyKey] = loaded.filter(e => e !== null);
                } else {
                    const result = await getDocClient().send(new GetCommand({
                        TableName: entityMetadata.tableName,
                        Key: idValue
                    }));
                    if (result.Item) {
                        (this as any)[link.propertyKey] = instantiate(result.Item);
                    }
                }
            } else if (parentMetadata.sortKeyName) {
                // ── Non-inline path: look up separate link records, then fetch each entity ──
                const parentHKVal = String(parentKey[parentMetadata.hashKeyName]);
                const parentSKVal = String(parentKey[parentMetadata.sortKeyName]);
                const skPrefix = `${encodeLinkSegment(parentHKVal)}#${encodeLinkSegment(parentSKVal)}#${encodeLinkSegment(link.propertyKey)}#`;

                const linkItems = await paginatedQuery({
                    TableName: parentMetadata.tableName,
                    KeyConditionExpression: '#pk = :pkval AND begins_with(#sk, :skprefix)',
                    ExpressionAttributeNames: {
                        '#pk': parentMetadata.hashKeyName,
                        '#sk': parentMetadata.sortKeyName
                    },
                    ExpressionAttributeValues: {
                        ':pkval': '__link',
                        ':skprefix': skPrefix
                    }
                });

                if (linkItems.length === 0) {
                    // For array links with no records, set to empty array instead of leaving undefined
                    if (link.isArray) {
                        (this as any)[link.propertyKey] = [];
                    }
                    continue;
                }

                const loaded = await Promise.all(
                    linkItems.map(async (linkRecord: any) => {
                        const linkedKey: any = {
                            [entityMetadata.hashKeyName]: linkRecord.linkedHashKey
                        };
                        if (entityMetadata.sortKeyName) {
                            linkedKey[entityMetadata.sortKeyName] = linkRecord.linkedSortKey;
                        }
                        const result = await getDocClient().send(new GetCommand({
                            TableName: entityMetadata.tableName,
                            Key: linkedKey
                        }));
                        return result.Item ? instantiate(result.Item) : null;
                    })
                );

                const filtered = loaded.filter(e => e !== null);
                // Use stored link.isArray (from decoration time) to reconstruct the original shape
                (this as any)[link.propertyKey] = link.isArray ? filtered : (filtered[0] ?? null);
            }
        }

        return this;
    }

    static configure(dynamoDBClient: DynamoDBClient, documentClientConfig?: any) {
        configureClient(dynamoDBClient, documentClientConfig);
    }

    static async get<T extends BaseEntity>(this: new (...args: any[]) => T, sortKeyValue: any): Promise<T | null> {
        const metadata = (this as any).__entityMetadata__;
        const tempInstance = new this() as any;

        const hashKeyValue = metadata.hashKeyGetter ? tempInstance[metadata.hashKeyGetter] : undefined;

        const key: any = {
            [metadata.hashKeyName]: hashKeyValue
        };

        if (metadata.sortKeyName && sortKeyValue !== undefined) {
            key[metadata.sortKeyName] = sortKeyValue;
        }

        const result = await getDocClient().send(new GetCommand({
            TableName: metadata.tableName,
            Key: key
        }));

        if (!result.Item) {
            return null;
        }

        const instance = new this() as T;
        return instance.fromItem(result.Item);
    }

    static async query<T extends BaseEntity>(this: new (...args: any[]) => T, options?: QueryOptions): Promise<T[]> {
        const metadata = (this as any).__entityMetadata__;
        const tempInstance = new this() as any;

        const hashKeyValue = metadata.hashKeyGetter ? tempInstance[metadata.hashKeyGetter] : undefined;

        let keyConditionExpression = `#hk = :hkval`;
        const expressionAttributeNames: any = {
            '#hk': metadata.hashKeyName
        };
        const expressionAttributeValues: any = {
            ':hkval': hashKeyValue
        };

        if (options?.sortKeyCondition && metadata.sortKeyName) {
            const sk = metadata.sortKeyName;
            expressionAttributeNames['#sk'] = sk;

            const condition = options.sortKeyCondition;
            switch (condition.type) {
                case 'equals':
                    keyConditionExpression += ` AND #sk = :skval`;
                    expressionAttributeValues[':skval'] = condition.value;
                    break;
                case 'lessThan':
                    keyConditionExpression += ` AND #sk < :skval`;
                    expressionAttributeValues[':skval'] = condition.value;
                    break;
                case 'lessThanOrEqual':
                    keyConditionExpression += ` AND #sk <= :skval`;
                    expressionAttributeValues[':skval'] = condition.value;
                    break;
                case 'greaterThan':
                    keyConditionExpression += ` AND #sk > :skval`;
                    expressionAttributeValues[':skval'] = condition.value;
                    break;
                case 'greaterThanOrEqual':
                    keyConditionExpression += ` AND #sk >= :skval`;
                    expressionAttributeValues[':skval'] = condition.value;
                    break;
                case 'between':
                    keyConditionExpression += ` AND #sk BETWEEN :skstart AND :skend`;
                    expressionAttributeValues[':skstart'] = condition.start;
                    expressionAttributeValues[':skend'] = condition.end;
                    break;
                case 'startsWith':
                    keyConditionExpression += ` AND begins_with(#sk, :skval)`;
                    expressionAttributeValues[':skval'] = condition.value;
                    break;
            }
        }

        const queryParams: any = {
            TableName: metadata.tableName,
            KeyConditionExpression: keyConditionExpression,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues
        };

        if (options?.limit) {
            queryParams.Limit = options.limit;
        }

        if (options?.scanIndexForward !== undefined) {
            queryParams.ScanIndexForward = options.scanIndexForward;
        }

        const result = await getDocClient().send(new QueryCommand(queryParams));

        if (!result.Items || result.Items.length === 0) {
            return [];
        }

        return result.Items.map(item => {
            const instance = new this() as T;
            return instance.fromItem(item);
        });
    }

    static async queryAll<T extends BaseEntity>(this: new (...args: any[]) => T, options?: QueryHelperOptions): Promise<T[]> {
        return (this as any).query(options);
    }

    static async queryStartsWith<T extends BaseEntity>(this: new (...args: any[]) => T, sortKeyPrefix: string, options?: QueryHelperOptions): Promise<T[]> {
        return (this as any).query({
            sortKeyCondition: { type: 'startsWith', value: sortKeyPrefix },
            ...options
        });
    }

    static async queryBetween<T extends BaseEntity>(this: new (...args: any[]) => T, start: any, end: any, options?: QueryHelperOptions): Promise<T[]> {
        return (this as any).query({
            sortKeyCondition: { type: 'between', start, end },
            ...options
        });
    }

    static async queryGreaterThan<T extends BaseEntity>(this: new (...args: any[]) => T, sortKeyValue: any, options?: QueryHelperOptions): Promise<T[]> {
        return (this as any).query({
            sortKeyCondition: { type: 'greaterThan', value: sortKeyValue },
            ...options
        });
    }

    static async queryLessThan<T extends BaseEntity>(this: new (...args: any[]) => T, sortKeyValue: any, options?: QueryHelperOptions): Promise<T[]> {
        return (this as any).query({
            sortKeyCondition: { type: 'lessThan', value: sortKeyValue },
            ...options
        });
    }

    static async queryEquals<T extends BaseEntity>(this: new (...args: any[]) => T, sortKeyValue: any, options?: QueryHelperOptions): Promise<T[]> {
        return (this as any).query({
            sortKeyCondition: { type: 'equals', value: sortKeyValue },
            ...options
        });
    }
}
