import 'dotenv/config';
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { BaseEntity, Entity, FromDbModel, HashKeyValue, LinkArray, LinkObject, SortKeyValue, ToDbModel } from "./dynamoDbORM";
import { paginatedQuery, encodeLinkSegment, getDocClient } from './client';


@Entity('test_table', '__hKey', '__sKey') // or @Entity('test_table', '__hKey', '__sKey', new DynamoDBClient({...}))
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
@Entity('test_table', '__hKey', '__sKey')
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
@Entity('test_table', '__hKey', '__sKey')
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

/**
 * SOCIAL USER
 */
@Entity('test_table', '__hKey', '__sKey')
class SocialUser extends BaseEntity {
    @HashKeyValue
    get hashKey() {
        return 'SOCIAL_USER';
    }

    @SortKeyValue
    get sortKey() {
        return this.userId;
    }

    userId: string;
    handle: string;
    displayName: string;
    bio: string;

    constructor(userId: string = '', handle: string = '', displayName: string = '', bio: string = '') {
        super();
        this.userId = userId;
        this.handle = handle;
        this.displayName = displayName;
        this.bio = bio;
    }

    get profileLabel(): string {
        return `@${this.handle} (${this.displayName})`;
    }
}

/**
 * SOCIAL COMMENT
 */
@Entity('test_table', '__hKey', '__sKey')
class SocialComment extends BaseEntity {
    @HashKeyValue
    get hashKey() {
        return 'COMMENT';
    }

    @SortKeyValue
    get sortKey() {
        return this.commentId;
    }

    commentId: string;
    body: string;

    @LinkObject(SocialUser)
    author: SocialUser | undefined;

    @LinkArray(SocialUser)
    likedBy: SocialUser[] = [];

    createdAt: Date;

    constructor(commentId: string = '', body: string = '', author?: SocialUser) {
        super();
        this.commentId = commentId;
        this.body = body;
        this.author = author;
        this.createdAt = new Date();
    }

    like(user: SocialUser) {
        if (!this.likedBy.some(existing => existing.userId === user.userId)) {
            this.likedBy.push(user);
        }
    }

    @ToDbModel
    static toDbModel(comment: SocialComment) {
        return {
            createdAt: comment.createdAt.toISOString()
        };
    }

    @FromDbModel
    static fromDbModel(item: { createdAt?: string }) {
        return {
            createdAt: item.createdAt ? new Date(item.createdAt) : new Date()
        };
    }
}

/**
 * SOCIAL POST
 */
@Entity('test_table', '__hKey', '__sKey')
class SocialPost extends BaseEntity {
    @HashKeyValue
    get hashKey() {
        return 'POST';
    }

    @SortKeyValue
    get sortKey() {
        return this.postId;
    }

    postId: string;
    body: string;
    tags: string[];

    @LinkObject(SocialUser)
    author: SocialUser | undefined;

    @LinkArray(SocialComment)
    comments: SocialComment[] = [];

    @LinkArray(SocialUser)
    likedBy: SocialUser[] = [];

    createdAt: Date;
    updatedAt: Date;

    constructor(postId: string = '', body: string = '', author?: SocialUser, tags: string[] = []) {
        super();
        this.postId = postId;
        this.body = body;
        this.author = author;
        this.tags = tags;
        this.comments = [];
        this.likedBy = [];
        this.createdAt = new Date();
        this.updatedAt = new Date();
    }

    addComment(comment: SocialComment) {
        this.comments.push(comment);
        this.updatedAt = new Date();
    }

    like(user: SocialUser) {
        if (!this.likedBy.some(existing => existing.userId === user.userId)) {
            this.likedBy.push(user);
            this.updatedAt = new Date();
        }
    }

    unlike(userId: string) {
        this.likedBy = this.likedBy.filter(user => user.userId !== userId);
        this.updatedAt = new Date();
    }

    @ToDbModel
    static toDbModel(post: SocialPost) {
        return {
            tags: post.tags,
            createdAt: post.createdAt.toISOString(),
            updatedAt: post.updatedAt.toISOString()
        };
    }

    @FromDbModel
    static fromDbModel(item: { tags?: string[]; createdAt?: string; updatedAt?: string }) {
        return {
            tags: item.tags ?? [],
            createdAt: item.createdAt ? new Date(item.createdAt) : new Date(),
            updatedAt: item.updatedAt ? new Date(item.updatedAt) : new Date()
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
// Solution: Pass cascadeSave=true to insert(). The ORM walks the object graph,
// saves User + Products first, then the Order, then writes the link records
// that tie them together.
// ─────────────────────────────────────────────────────────────────────────────

async function placeOrder() {
    const customer = new User('u-alice', 'alice@example.com');

    const order = new Order('o-1001', customer);
    order.addItem(new Product('p-laptop', 'Laptop', 999.99));
    order.addItem(new Product('p-mouse',  'Mouse',   29.99));

    await order.insert(true); // cascadeSave=true: saves user, products, then order, then link records

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
// Solution: Mutate the items array and call insert(true) again. The ORM diffs
// the existing link records, removes the stale ones (and their backlinks on
// the old product), and writes fresh ones for the new product. cascadeSave=true
// ensures the new product is saved before linking.
// ─────────────────────────────────────────────────────────────────────────────

async function replaceOrderItem(orderId: string) {
    const order = await Order.get(orderId);
    await order!.loadLinks();

    order!.removeItem('p-mouse');
    order!.addItem(new Product('p-keyboard', 'Keyboard', 49.99));

    // insert(true) deletes old link+backlink for p-mouse, writes new ones for p-keyboard
    await order!.insert(true);
    console.log('Order updated. New total:', order!.total);
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 9 — Order cancellation: Delete an order and clean up all links
//
// Problem: A cancelled order must be removed cleanly.
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
// product's key directly on the Receipt item cascadeSave=true ensures the
// product exists before the receipt is saved.. loadLinks() resolves with
// a single GetItem — no prefix query needed.
// ─────────────────────────────────────────────────────────────────────────────

@Entity('test_table', '__hKey', '__sKey')
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

    await receipt.insert(true); // cascadeSave=true: saves product first, then writes __productID inline

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
    const recentOrders = await Order.queryGreaterThan('2024-01-01', {
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

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 14 — Social media: Publish a post with comments and likes
//
// Problem: A post detail page needs the author, a comment thread, and likes.
// In raw DynamoDB you'd coordinate m and use insert(true). cascadeSave=true
// tells the ORM to save all linked entities: users, comments (and their authors),
// then the post itself, then all link/backlink records
// Solution: Model the graph directly. insert() saves the post, its author,
// every comment, each comment author, and the users who liked the post.
// ─────────────────────────────────────────────────────────────────────────────

async function publishSocialPost() {
    const alice = new SocialUser('user-alice', 'alice', 'Alice Kim', 'Frontend engineer sharing product notes.');
    const bob = new SocialUser('user-bob', 'bob', 'Bob Singh', 'Backend builder and coffee snob.');
    const carol = new SocialUser('user-carol', 'carol', 'Carol Diaz', 'Community lead and release wrangler.');

    const post = new SocialPost(
        'post-1001',
        'We just rolled out a feed redesign with faster image loading and better ranking.',
        alice,
        ['release', 'feed', 'performance']
    );

    const firstComment = new SocialComment('comment-9001', 'The new timeline feels noticeably faster on mobile.', bob);
    firstComment.like(alice);

    const secondComment = new SocialComment('comment-9002', 'Please add muted keywords next.', carol);

    post.addComment(firstComment);
    post.addComment(secondComment);
    post.like(bob);
    post.like(carol);

    await post.insert(true); // cascadeSave=true: saves users, comments, post, then all link records

    console.log(`Post saved with ${post.comments.length} comments and ${post.likedBy.length} likes.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 15 — Thread view: Load a post, its comments, and all participating users
//
// Problem: A thread screen has nested relations: the post author, comment
// authors, and the users who liked each object.
//
// Solution: loadLinks() hydrates one level at a time. Load the post, then fan
// out to each comment in parallel for a fully typed thread object graph.
// ─────────────────────────────────────────────────────────────────────────────

async function renderSocialThread(postId: string) {
    const post = await SocialPost.get(postId);
    if (!post) throw new Error('Post not found');

    await post.loadLinks();
    await Promise.all(post.comments.map(comment => comment.loadLinks()));

    console.log(`${post.author?.profileLabel}: ${post.body}`);
    console.log('Post likes:', post.likedBy.map(user => `@${user.handle}`).join(', '));

    for (const comment of post.comments) {
        const likedBy = comment.likedBy.map(user => `@${user.handle}`).join(', ');
        console.log(`- ${comment.author?.profileLabel}: ${comment.body}`);
        console.log(`  Likes: ${likedBy || 'none'}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 16 — Profile page: Find every post a user liked
//              (reverse traversal via backlinks)
//
// Problem: A profile screen wants a "posts you liked" tab. Without backlinks,
// you'd scan all posts and inspect every likedBy link in application code.
//
// Solution: Every SocialPost.likedBy link writes a __backlink record onto the
// linked SocialUser, so you can query from the user out to posts directly.
// ─────────────────────────────────────────────────────────────────────────────

async function findPostsLikedByUser(userId: string): Promise<SocialPost[]> {
    const userMeta = (SocialUser as any).__entityMetadata__;
    const prefix = `${encodeLinkSegment('SOCIAL_USER')}#${encodeLinkSegment(userId)}#`;

    const backlinks = await paginatedQuery({
        TableName: userMeta.tableName,
        KeyConditionExpression: '#pk = :pkval AND begins_with(#sk, :skprefix)',
        ExpressionAttributeNames: { '#pk': userMeta.hashKeyName, '#sk': userMeta.sortKeyName },
        ExpressionAttributeValues: { ':pkval': '__backlink', ':skprefix': prefix },
    });

    const likedPostBacklinks = backlinks.filter(
        (backlink: any) => backlink.parentHashKey === 'POST' && backlink.propertyKey === 'likedBy'
    );

    const posts = await Promise.all(
        likedPostBacklinks.map(async (backlink: any) => {
            const result = await getDocClient().send(new GetCommand({
                TableName: backlink.parentTableName,
                Key: {
                    [backlink.parentHashKeyName]: backlink.parentHashKey,
                    [backlink.parentSortKeyName]: backlink.parentSortKey,
                },
            }));

            if (!result.Item) {
                return null;
            }

            const instance = new SocialPost();
            Object.assign(instance, result.Item, SocialPost.fromDbModel(result.Item));
            return instance;
        })
    );

    return posts.filter((post): post is SocialPost => post !== null);
}

async function socialProfileLikesTab(userId: string) {
    const likedPosts = await findPostsLikedByUser(userId);
    await Promise.all(likedPosts.map(post => post.loadLinks()));

    for (const post of likedPosts) {
        console.log(`Liked post → ${post.postId} by @${post.author?.handle}`);
    }
}
