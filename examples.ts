import 'dotenv/config';
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { BaseEntity, Entity, FromDbModel, HashKeyValue, LinkArray, LinkObject, SortKeyValue, ToDbModel } from "./dynamoDbORM";
import { paginatedQuery, encodeLinkSegment, getDocClient } from './client';



@Entity('test', 'hKey', 'sKey') // or @Entity('test', 'hKey', 'sKey', new DynamoDBClient({...}))
class Wheel extends BaseEntity {
    @HashKeyValue
    get hashKey() { return `WHEEL`; }
    @SortKeyValue
    get sortKey() { return `${this.wheelID}`; }

    wheelID: number;

    constructor(wheelID: number = 0) {
        super();
        this.wheelID = wheelID;
    }
}

@Entity('test', 'hKey', 'sKey')
class Engine extends BaseEntity {
    @HashKeyValue
    get hashKey() { return "Engine"; }
    @SortKeyValue
    get sortKey() { return this.engineID.toString(); }

    engineID: number;
    capacity: number;
    numberOfCylinders: number;

    constructor(engineID: number = 0, capacity: number = 0, numberOfCylinders = 0) {
        super();
        this.engineID = engineID;
        this.capacity = capacity;
        this.numberOfCylinders = numberOfCylinders;
    }

}

@Entity('test', 'hKey', 'sKey')
class Car extends BaseEntity {
    @HashKeyValue
    get hashKey() { return 'Car'; }
    @SortKeyValue
    get sortKey() { return this.carID.toString(); }

    carID: number;
    make: string;
    model: string;
    year: number;
    @LinkArray(Wheel)
    wheels: Wheel[] | undefined;
    @LinkObject(Engine)
    engine: Engine | undefined;
    createdAt: Date | undefined;
    updatedAt: Date | undefined;

    constructor(carID: number = 0, make: string = '', model: string = '', year: number = 0) {
        super();
        this.carID = carID;
        this.make = make;
        this.model = model;
        this.year = year;
    }

    @ToDbModel
    static toDBModelMapper(instance: Car) {
        // Custom transformation before saving to DB
        return {
            ...instance,
            updatedAt: new Date().toISOString(),
            createdAt: instance.createdAt ? instance.createdAt.toISOString() : new Date().toISOString(),
        };
    }

    @FromDbModel
    static fromDBModelMapper(dbModel: any): Car {
        // Custom transformation after loading from DB
        return {
            ...dbModel,
            updatedAt: new Date(dbModel.updatedAt),
            createdAt: new Date(dbModel.createdAt),
        };
    }
}



















@Entity('test', 'hKey', 'sKey')
export class User extends BaseEntity {
    @HashKeyValue
    get hashKey() {
        return 'USER';
    }

    @SortKeyValue
    get sortKey() {
        return this.userId;
    }

    userId: string;
    email: string;

    constructor(userId: string = '', email: string = '') {
        super();
        this.userId = userId;
        this.email = email;
    }

    // example instance method
    getDisplayEmail(): string {
        return this.email.toLowerCase();
    }
}

/**
 * PRODUCT
 */
@Entity('test', 'hKey', 'sKey')
export class Product extends BaseEntity {
    @HashKeyValue
    get hashKey() {
        return 'PRODUCT';
    }

    @SortKeyValue
    get sortKey() {
        return this.productId;
    }

    productId: string;
    name: string;
    price: number;

    constructor(productId: string = '', name: string = '', price: number = 0) {
        super();
        this.productId = productId;
        this.name = name;
        this.price = price;
    }

    isExpensive(threshold: number = 100): boolean {
        return this.price >= threshold;
    }
}

/**
 * ORDER
 */
@Entity('test', 'hKey', 'sKey')
export class Order extends BaseEntity {
    @HashKeyValue
    get hashKey() {
        return 'ORDER';
    }

    @SortKeyValue
    get sortKey() {
        return this.orderId;
    }

    orderId: string;

    @LinkObject(User)
    customer: User | undefined;

    @LinkArray(Product)
    items: Product[] = [];

    total: number;
    createdAt: Date;

    constructor(orderId: string = '', customer?: User) {
        super();
        this.orderId = orderId;
        this.customer = customer;
        this.items = [];
        this.total = 0;
        this.createdAt = new Date();
    }

    addItem(product: Product) {
        this.items.push(product);
        this.recalculateTotal();
    }

    removeItem(productId: string) {
        this.items = this.items.filter(p => p.productId !== productId);
        this.recalculateTotal();
    }

    recalculateTotal() {
        this.total = this.items.reduce((sum, p) => sum + p.price, 0);
    }

    @ToDbModel
    static toDbModel(order: Order) {
        return {
            createdAt: order.createdAt.toISOString()
        };
    }

    @FromDbModel
    static fromDbModel(item: { createdAt?: string }) {
        return {
            createdAt: item.createdAt ? new Date(item.createdAt) : new Date()
        };
    }
}












// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

BaseEntity.configure(
    new DynamoDBClient({
        region: process.env.AWS_REGION,
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
        },
    })
);

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 1 — E-commerce: Customer places an order
//
// Problem: You need to save an order, its customer, and its line items in one go.
// In a relational DB you'd insert 3 tables and manage FK constraints.
// In raw DynamoDB you'd manually write every item and manage composite keys.
//
// Solution: Just set the properties and call insert() once.
// The ORM cascades: saves User + Products first, then the Order,
// then writes the link records that tie them together.
// ─────────────────────────────────────────────────────────────────────────────

async function placeOrder() {
    const customer = new User('u-alice', 'alice@example.com');

    const order = new Order('o-1001', customer);
    order.addItem(new Product('p-laptop', 'Laptop', 999.99));
    order.addItem(new Product('p-mouse',  'Mouse',   29.99));

    await order.insert(); // one call — cascades to user, products, links

    console.log('Order saved. Total:', order.total); // 1029.98
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 2 — Order detail page: Load an order and all its related data
//
// Problem: The order detail page needs the customer name + email and every
// product's name + price. In raw DynamoDB you'd fire a GetItem for the order,
// then separate GetItem calls for each linked entity, and stitch it manually.
//
// Solution: get() fetches the order, loadLinks() fires all the child lookups
// in parallel and populates the typed properties directly.
// ─────────────────────────────────────────────────────────────────────────────

async function renderOrderDetailPage(orderId: string) {
    const order = await Order.get(orderId);
    if (!order) throw new Error('Order not found');

    await order.loadLinks(); // parallel fetches for customer + all products

    console.log('Customer:',  order.customer?.email);
    console.log('Items:',     order.items.map(p => `${p.name} $${p.price}`));
    console.log('Total:',     order.total);
    console.log('Expensive?', order.items.some(p => p.isExpensive(500)));
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 3 — Admin dashboard: All orders with customer + item count
//
// Problem: An admin table shows every order with customer email and item count.
// Fetching hundreds of orders and then N linked entities each would be slow
// if done serially.
//
// Solution: queryAll() pages through every order in one sweep,
// then a single Promise.all hydrates them all in parallel — one batch of
// concurrent GetItem calls, not a sequential waterfall.
// ─────────────────────────────────────────────────────────────────────────────

async function adminOrderDashboard() {
    const orders = await Order.queryAll();
    await Promise.all(orders.map(o => o.loadLinks())); // parallel hydration

    for (const o of orders) {
        console.log(`[${o.orderId}] ${o.customer?.email ?? 'Guest'} | ${o.items.length} items | $${o.total}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 4 — Product page: "142 customers bought this"
//              (reverse traversal via backlinks)
//
// Problem: You want to show how many orders contain a given product.
// In a relational DB this is a simple COUNT JOIN.
// In DynamoDB without backlinks you'd have to scan every order — very expensive.
//
// The ORM writes a __backlink record into the Product's table every time
// an Order links to that product, so you can query it directly.
// ─────────────────────────────────────────────────────────────────────────────

async function getOrderCountForProduct(productId: string): Promise<number> {
    const productMeta = (Product as any).__entityMetadata__;
    const prefix = `${encodeLinkSegment('PRODUCT')}#${encodeLinkSegment(productId)}#`;

    const backlinks = await paginatedQuery({
        TableName: productMeta.tableName,
        KeyConditionExpression: '#pk = :pkval AND begins_with(#sk, :skprefix)',
        ExpressionAttributeNames: { '#pk': productMeta.hashKeyName, '#sk': productMeta.sortKeyName },
        ExpressionAttributeValues: { ':pkval': '__backlink', ':skprefix': prefix },
    });

    return backlinks.length; // one backlink record per order that contains this product
}

async function productPageExample() {
    const product = await Product.get('p-laptop');
    const orderCount = await getOrderCountForProduct('p-laptop');
    console.log(`${product?.name} has been ordered ${orderCount} times`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 5 — Product recall / support: Find every order containing a product
//
// Problem: A defective product needs a refund issued to every affected customer.
// You need all orders that contain 'p-laptop'. Without backlinks you'd scan
// the entire orders table and filter in application code.
//
// Solution: Walk the backlink records on the Product to get parent Order keys,
// then fetch each Order in parallel.
// ─────────────────────────────────────────────────────────────────────────────

async function findOrdersContainingProduct(productId: string): Promise<Order[]> {
    const productMeta = (Product as any).__entityMetadata__;
    const orderMeta   = (Order as any).__entityMetadata__;
    const prefix = `${encodeLinkSegment('PRODUCT')}#${encodeLinkSegment(productId)}#`;

    const backlinks = await paginatedQuery({
        TableName: productMeta.tableName,
        KeyConditionExpression: '#pk = :pkval AND begins_with(#sk, :skprefix)',
        ExpressionAttributeNames: { '#pk': productMeta.hashKeyName, '#sk': productMeta.sortKeyName },
        ExpressionAttributeValues: { ':pkval': '__backlink', ':skprefix': prefix },
    });

    // A product could be linked from multiple entity types; filter to Orders only.
    const orderBacklinks = backlinks.filter((bl: any) => bl.parentTableName === orderMeta.tableName);

    const orders = await Promise.all(
        orderBacklinks.map(async (bl: any) => {
            const result = await getDocClient().send(new GetCommand({
                TableName: bl.parentTableName,
                Key: { [bl.parentHashKeyName]: bl.parentHashKey, [bl.parentSortKeyName]: bl.parentSortKey },
            }));
            if (!result.Item) return null;
            const instance = new Order();
            Object.assign(instance, result.Item);
            return instance;
        })
    );

    return orders.filter(Boolean) as Order[];
}

async function productRecallSupport() {
    const affectedOrders = await findOrdersContainingProduct('p-laptop');
    await Promise.all(affectedOrders.map(o => o.loadLinks()));

    for (const o of affectedOrders) {
        console.log(`Refund → ${o.customer?.email} for order ${o.orderId}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 6 — Inventory management: Block deletion of a product still in orders
//
// Problem: A warehouse manager tries to remove a discontinued product.
// Deleting it while orders still reference it would leave those orders with
// dangling links — loadLinks() would silently return null for that product.
//
// Solution: delete() automatically checks inbound backlinks. If any orders
// still hold a reference it throws, keeping the product intact. Remove it
// from all orders first (or cancel/delete those orders), then delete.
// ─────────────────────────────────────────────────────────────────────────────

async function safeDeleteProduct(productId: string) {
    const product = await Product.get(productId);
    if (!product) throw new Error(`Product "${productId}" not found`);

    // Throws automatically if any order still references this product.
    // Error: "Cannot delete: still referenced by N record(s). Remove all references first."
    await product.delete();
    console.log(`Product ${productId} deleted.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 7 — Account settings: Customer changes their email
//
// Problem: Alice updates her email address. She is the customer on 50 orders.
// In a DB that denormalizes the email onto every order item you'd need 50 updates.
//
// Solution: The ORM stores Alice's User entity exactly once. Every order holds
// only a link key pointing to it. Update Alice once — every order that calls
// loadLinks() will automatically see the new email on next read.
// ─────────────────────────────────────────────────────────────────────────────

async function updateCustomerEmail(userId: string, newEmail: string) {
    const user = await User.get(userId);
    if (!user) throw new Error('User not found');

    await user.update({ email: newEmail }); // one write, all linked orders reflect it
    console.log('Email updated. All linked orders will see the change on next loadLinks().');
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 8 — Order modification: Customer swaps a product for another
//
// Problem: A customer calls support and wants to replace the Mouse with a
// Keyboard in their existing order. In raw DynamoDB you'd delete the old
// __link record, write a new one, update backlinks on both products — 4+ ops.
//
// Solution: Mutate the items array and call insert() again. The ORM diffs
// the existing link records, removes the stale ones (and their backlinks on
// the old product), and writes fresh ones for the new product.
// ─────────────────────────────────────────────────────────────────────────────

async function replaceOrderItem(orderId: string) {
    const order = await Order.get(orderId);
    await order!.loadLinks();

    order!.removeItem('p-mouse');
    order!.addItem(new Product('p-keyboard', 'Keyboard', 49.99));

    // insert() deletes old link+backlink for p-mouse, writes new ones for p-keyboard
    await order!.insert();
    console.log('Order updated. New total:', order!.total);
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 9 — Order cancellation: Delete an order and clean up all links
//
// Problem: A cancelled order must be removed cleanly. You have to remove the
// order item, every __link record it owns, and the corresponding __backlink
// records on the User and Product tables — easy to miss one and create ghosts.
//
// Solution: order.delete() handles all of it automatically:
//   1. Deletes every __link record owned by the order (→ user, → products)
//   2. Deletes every __backlink record on User and Products pointing back here
//   3. Deletes the Order item itself
// User and Product items are untouched — only the relationship wiring is removed.
// ─────────────────────────────────────────────────────────────────────────────

async function cancelOrder(orderId: string) {
    const order = await Order.get(orderId);
    if (!order) throw new Error('Order not found');

    await order.delete(); // full graph cleanup in one call

    const productStillExists = await Product.get('p-laptop');
    console.log('Product still in catalogue:', !!productStillExists); // true
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 10 — High-read path: Receipts that don't need reverse lookups
//               (inline links — no __link/__backlink records)
//
// Problem: A receipt micro-service reads millions of receipts per day.
// It only needs to resolve the product name for display. It never needs to
// answer "which receipts contain this product?" — so the extra __link and
// __backlink records are pure overhead (extra writes, extra storage, extra reads).
//
// Solution: @LinkObject(Product, { inline: true }) embeds the linked
// product's key directly on the Receipt item. loadLinks() resolves with
// a single GetItem — no prefix query needed.
// ─────────────────────────────────────────────────────────────────────────────

@Entity('test', 'hKey', 'sKey')
class Receipt extends BaseEntity {
    @HashKeyValue get hashKey() { return 'RECEIPT'; }
    @SortKeyValue get sortKey() { return this.receiptId; }

    receiptId: string;

    // Key stored inline on the Receipt item as __productID: { hKey, sKey }
    // No separate link or backlink records are written.
    @LinkObject(Product, { inline: true })
    product: Product | undefined;

    constructor(receiptId: string = '') {
        super();
        this.receiptId = receiptId;
    }
}

async function inlineLinksExample() {
    const product = new Product('p-3', 'Notebook', 4.99);
    const receipt = new Receipt('r-1');
    receipt.product = product;

    await receipt.insert(); // writes __productID: { hKey: 'PRODUCT', sKey: 'p-3' } onto Receipt

    const loaded = await Receipt.get('r-1');
    await loaded!.loadLinks(); // resolves with one GetItem — no prefix query
    console.log(loaded!.product?.name); // "Notebook"
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 11 — Finance report: Orders in a date range, newest first
//
// Problem: The finance team wants all orders from Q1 2024, paginated newest
// first, with full customer and item detail for their spreadsheet export.
//
// Solution: Use ISO-timestamp-prefixed sort keys so DynamoDB's key ordering
// gives you chronological queries for free. queryBetween / query with
// scanIndexForward: false gives you the range + direction in one API call.
// ─────────────────────────────────────────────────────────────────────────────

async function q1FinanceReport() {
    // Assumes orderId is an ISO timestamp e.g. "2024-01-15T10:00:00Z_o-1001"
    const q1Orders = await Order.queryBetween('2024-01-01', '2024-04-01');

    // Or: latest 20 orders since Jan 1
    const recentOrders = await Order.query({
        sortKeyCondition: { type: 'greaterThan', value: '2024-01-01' },
        limit: 20,
        scanIndexForward: false, // newest first
    });

    await Promise.all(recentOrders.map(o => o.loadLinks()));
    for (const o of recentOrders) {
        console.log(`${o.orderId} | ${o.customer?.email} | $${o.total}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 12 — Post-migration audit: Verify every link record is intact
//
// Problem: After a bulk data import you want to confirm every order has its
// __link records written correctly, or you're building a consistency check
// to catch any ghost records left by a previous buggy deploy.
//
// Solution: Query all __link records in the table directly. Each one has
// a structured sort key you can parse to verify source + destination.
// ─────────────────────────────────────────────────────────────────────────────

async function auditLinkIntegrity() {
    const meta = (Order as any).__entityMetadata__;

    const linkRecords = await paginatedQuery({
        TableName: meta.tableName,
        KeyConditionExpression: '#pk = :pkval',
        ExpressionAttributeNames: { '#pk': meta.hashKeyName },
        ExpressionAttributeValues: { ':pkval': '__link' },
    });

    console.log(`Found ${linkRecords.length} link records.`);
    for (const rec of linkRecords) {
        // SK format: {parentHK}#{parentSK}#{property}#{linkedHK}#{linkedSK}
        console.log('Link:', rec[meta.sortKeyName], '→', rec.linkedHashKey, '/', rec.linkedSortKey);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 13 — Any entity with Date fields: Clean round-trip through DynamoDB
//
// Problem: DynamoDB has no native Date type. Without a mapper, order.createdAt
// comes back as a raw string, breaking .toLocaleDateString() and date comparisons.
//
// Solution: @ToDbModel converts Date → ISO string on save.
//           @FromDbModel converts it back on load.
// The rest of your application code never sees the raw string.
// ─────────────────────────────────────────────────────────────────────────────

async function dateRoundTripExample() {
    const order = new Order('o-99');
    order.createdAt = new Date('2024-03-15T14:30:00Z');
    await order.insert();
    // Stored in DynamoDB: createdAt = "2024-03-15T14:30:00.000Z"

    const loaded = await Order.get('o-99');
    console.log(loaded!.createdAt instanceof Date);       // true
    console.log(loaded!.createdAt.getFullYear());         // 2024
    console.log(loaded!.createdAt.toLocaleDateString());  // locale-formatted date
}
