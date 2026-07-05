import 'dotenv/config';
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BaseEntity, Entity, FromDbModel, HashKeyValue, LinkArray, LinkObject, SortKeyValue, ToDbModel } from "./dynamoDbORM";


@Entity('test_table', '__hKey', '__sKey') // or @Entity('test_table', '__hKey', '__sKey', new DynamoDBClient({...}))
class Post extends BaseEntity {
    @HashKeyValue
    get hashKey() { return `POST`; }
    @SortKeyValue
    get sortKey() { return `${this.postID}`; }

    postID: string;
    title: string;
    content: string;

    constructor(title: string, content: string) {
        super();
        this.postID = crypto.randomUUID(); // ULID could be a better choice, ULID instead of a random UUID: it's lexicographically sortable by creation time, which is what makes the date-range queries on posts further down work.
        this.title = title;
        this.content = content;
    }
}

export type Language = "en" | "fa" | "it" | "es";
export type Theme = "dark" | "light";

@Entity('test_table', '__hKey', '__sKey')
class Settings extends BaseEntity {
    @HashKeyValue
    get hashKey() { return "SETTINGS"; }
    @SortKeyValue
    get sortKey() { return this.settingsID.toString(); }

    settingsID: string;
    language: Language;
    theme: Theme;

    constructor(language?: Language, theme?: Theme) {
        super();
        this.settingsID = crypto.randomUUID();
        this.language = language || "en";
        this.theme = theme || "light";
    }

}

@Entity('test_table', '__hKey', '__sKey')
class User extends BaseEntity {
    @HashKeyValue
    get hashKey() { return 'USER'; }
    @SortKeyValue
    get sortKey() { return this.userID.toString(); }

    userID: string;
    name: string;
    surname: string;
    age: number;
    @LinkObject(Settings)
    settings: Settings | undefined;
    @LinkArray(Post)
    posts: Post[] | undefined;
    createdAt: Date | undefined;
    updatedAt: Date | undefined;

    constructor(name: string, surname: string, age: number) {
        super();
        this.userID = crypto.randomUUID();
        this.name = name;
        this.surname = surname;
        this.age = age;
    }

    @ToDbModel
    static toDBModelMapper(instance: User) {
        // Custom transformation before saving to DB
        return {
            ...instance,
            updatedAt: new Date().toISOString(),
            createdAt: instance.createdAt ? instance.createdAt.toISOString() : new Date().toISOString(),
        };
    }

    @FromDbModel
    static fromDBModelMapper(dbModel: any): User {
        // Custom transformation after loading from DB
        return {
            ...dbModel,
            updatedAt: new Date(dbModel.updatedAt),
            createdAt: new Date(dbModel.createdAt),
        };
    }
}







// Usage examples:
async function test() {
    // ===== CONFIGURATION (REQUIRED - must be called first) =====
    // Configure with custom region and credentials
    BaseEntity.configure(
        new DynamoDBClient({
            region: process.env.AWS_REGION,
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!
            }
        })
    );

    // Or configure for local DynamoDB
    // BaseEntity.configure(
    //     new DynamoDBClient({
    //         endpoint: 'http://localhost:8000',
    //         region: 'local'
    //     })
    // );

    // Or use default AWS credentials (from environment, IAM role, etc.)
    // BaseEntity.configure(new DynamoDBClient({ region: 'us-east-1' }));

    // ===== BASIC CRUD OPERATIONS =====

    // Create and save a user
    const user = new User('John', 'Doe', 30);
    await user.insert();

    // Get single item by sort key (hash key is automatic)
    const retrievedUser = await User.get(user.userID);

    // Update specific fields
    if (retrievedUser) {
        await retrievedUser.update({ name: 'Jane', surname: 'Smith' });
    }

    // Delete
    if (retrievedUser) {
        await retrievedUser.delete();
    }

    // ===== LINKED ENTITIES (@Link decorator) =====

    // Create user with linked posts
    const userWithPosts = new User('Alice', 'Walker', 28);
    userWithPosts.posts = [
        new Post('First Post', 'Content of the first post'),
        new Post('Second Post', 'Content of the second post'),
        new Post('Third Post', 'Content of the third post'),
        new Post('Fourth Post', 'Content of the fourth post')
    ];

    userWithPosts.settings = new Settings('en', 'dark');

    // Save user - posts are automatically saved first (cascade save)
    await userWithPosts.insert(true);

    // Retrieve user (posts will be IDs only)
    const loadedUser = await User.get(userWithPosts.userID);
    console.log(loadedUser?.posts); // undefined - links not loaded yet

    // Load linked entities
    if (loadedUser) {
        await loadedUser.loadLinks();
        console.log(loadedUser.posts); // Now populated with Post instances
    }


    loadedUser?.posts?.splice(2, 1);
    await loadedUser?.insert(true);
    const loadedUser2 = await User.get(userWithPosts.userID);

    // Load linked entities
    if (loadedUser2) {
        await loadedUser2.loadLinks();
        console.log(loadedUser2.posts); // Now populated with Post instances
    }

    // ===== QUERY EXAMPLES =====

    // Get all users
    const allUsers = await User.queryAll({ limit: 10 });

    // Query with sort key conditions
    const specificUsers = await User.queryEquals(user.userID);

    // If Post.postID is generated as a ULID rather than a random UUID, a ULID's
    // first 10 characters encode its creation timestamp in a way that sorts
    // lexicographically the same as chronologically. That means comparing two
    // ULIDs as plain strings is equivalent to comparing their creation times,
    // so these sort-key range queries double as date-range queries on posts.
    const postsInRange = await Post.queryBetween('01KVN82QE2VQNJNP1XVN51K0V8', '01KVN9AQTCY2AMATVDW505HZ9H');
    // https://github.com/ulid/javascript
    // import { ulid, encodeTime } from "ulid";
    // function ulidLowerBound(date: Date): string {
    //     return encodeTime(date.getTime(), 10) + '0000000000000000';  // Smallest possible ULID at this instant
    // }
    // function ulidUpperBound(date: Date): string {
    //     return encodeTime(date.getTime(), 10) + 'ZZZZZZZZZZZZZZZZ';  // Largest possible ULID at this instant
    // }
    // const postsInRange = await Post.queryBetween(ulidLowerBound('2026-01-01T00:00:00Z'), ulidUpperBound('2026-01-31T23:59:59Z'));
    const newerPosts = await Post.queryGreaterThan('01KVN82QE2VQNJNP1XVN51K0V8'); // posts created after this point in time
    const olderPosts = await Post.queryLessThan('01KVN9AQTCY2AMATVDW505HZ9H'); // posts created before this point in time
    // A ULID prefix match returns every post sharing that timestamp segment,
    // i.e. every post created within the same ~millisecond window
    const postsWithPrefix = await Post.queryStartsWith('01KVN82QE2VQ');

    // Advanced query with options - same ULID sort key, so 'greaterThan' still means
    // "created after this timestamp", not a plain alphabetic/numeric comparison
    const customQuery = await Post.query({
        sortKeyCondition: { type: 'greaterThan', value: '01KVN82QE2VQNJNP1XVN51K0V8' },
        limit: 20,
        scanIndexForward: false // descending order = newest posts first
    });

    // Query and load links for all results
    // Back to User here, not Post: User has @LinkObject (settings) and @LinkArray (posts)
    // fields, so loadLinks() has something to populate. Post defines no linked fields of
    // its own, so calling loadLinks() on Post instances wouldn't do anything meaningful.
    const allUsersWithLinks = await User.queryAll();
    await Promise.all(allUsersWithLinks.map(u => u.loadLinks()));
}

test().then(() => console.log("test completed"));