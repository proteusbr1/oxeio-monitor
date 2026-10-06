import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { DATE_ONLY, TAKA, TAKA_MSG } from '../common/patterns';

// ── employees ───────────────────────────────────────────────────────────────

/**
 * ⭐⭐ **`empCode` ইচ্ছাকৃতভাবে এখানে নেই — সার্ভার নিজে বানায়।**
 *
 * ⚠️ `forbidNonWhitelisted: true` (app.setup.ts) বলে কেউ পাঠালে ৪০০ পাবে,
 *    নীরবে উপেক্ষা নয়। এটাই চাওয়া: "পাঠালাম অথচ বসল না" অবস্থাটা এই
 *    ফিল্ডে সবচেয়ে বিপজ্জনক, কারণ কোডটা মানুষ চোখে চেনে।
 */
export class CreateEmployeeDto {
  @IsString() @MinLength(1) @MaxLength(120)
  fullName!: string;

  @IsOptional() @IsEmail() @MaxLength(200)
  email?: string;

  @IsOptional() @IsString() @MaxLength(120)
  designation?: string;

  @IsOptional() @IsString() @MaxLength(120)
  department?: string;

  /**
   * ⭐ কাজের ধরন — নিয়ম **কেবল এর উপরেই** বসে (যেমন ডিজাইনারের দৈনিক ২৫)।
   *
   * ⚠️ `designation`-এর বিকল্প নয়, পাশাপাশি: ওটা পদবি (মুক্ত-লেখা), এটা
   * শ্রেণি (নির্দিষ্ট তালিকা)। ⚠️ ঐচ্ছিক — না বসালে ওই কর্মী টার্গেটের
   * হিসাব থেকে **বাদ** থাকেন, শূন্য পান না।
   */
  @IsOptional() @IsIn(['designer', 'researcher', 'manager'])
  staffType?: 'designer' | 'researcher' | 'manager';

  @IsOptional() @IsInt() @Min(1)
  policyId?: number;

  @IsOptional() @Matches(TAKA, { message: TAKA_MSG })
  monthlySalary?: string;

  @IsOptional() @Matches(DATE_ONLY, { message: 'joinedOn must be in YYYY-MM-DD format' })
  joinedOn?: string;

  /**
   * ⭐⭐ **এই ডিজাইনারের নিজের দৈনিক টার্গেট** *(২৩ আগস্ট ২০২৬)* — মালিকের
   * কথায়: *"karo daily target 25 ta, kono designer er daily target 15 ta"*।
   *
   * ⚠️ **খালি রাখলে পলিসির সংখ্যাটাই খাটে** (`work_policies`-এর ২৫), শূন্য নয়।
   * `null` পাঠিয়ে আগের মান মুছে পলিসিতে ফেরানো যায়।
   * ⚠️⚠️ **০ বৈধ** — "এর টার্গেট বন্ধ"; সংখ্যা গোনা চলবে, কিন্তু কেউ পিছিয়ে নয়।
   * ⚠️ ছাদ ৫০০ — টাইপো ধরার জন্য, নীতির জন্য নয় (পলিসির ঘরের মতোই)।
   */
  @IsOptional() @IsInt() @Min(0) @Max(500)
  dailyDesignTarget?: number | null;}
/**
 * ⚠️ প্রতিটা ফিল্ড optional, আর `null`-ও গ্রহণযোগ্য — `@IsOptional()`
 * null ও undefined দুটোতেই যাচাই বাদ দেয়। এটা ইচ্ছাকৃত: `null` পাঠানো =
 * "মানটা মুছে দাও", ফিল্ড না পাঠানো = "হাত দিও না"। সার্ভিস `undefined`
 * দেখে দুটোকে আলাদা করে।
 */
export class UpdateEmployeeDto {
  /**
   * ⭐⭐ **`empCode` এখানেও নেই — একবার বসলে আর বদলায় না।**
   *
   * ⚠️ কোডটা কেবল একটা লেবেল নয়, মানুষের **পরিচয়**: রিপোর্ট, Excel,
   *    পে-রোল শিট, টেলিগ্রামের সারাংশ, এমনকি ছাপানো কাগজেও ওটাই লেখা
   *    থাকে। মাঝপথে বদলে গেলে পুরোনো কাগজ আর নতুন পর্দা দুই কথা বলত,
   *    অথচ কোথাও কোনো ভুল দেখা যেত না।
   * ⚠️ ডেটার দিক থেকেও বদলানোর দরকার নেই — ফাইলের পাথ ও সব foreign key
   *    employee **id** ধরে চলে, `empCode` ধরে নয়।
   */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120)
  fullName?: string;

  @IsOptional() @IsEmail() @MaxLength(200)
  email?: string | null;

  @IsOptional() @IsString() @MaxLength(120)
  designation?: string | null;

  @IsOptional() @IsString() @MaxLength(120)
  department?: string | null;

  /** ⚠️ `null` পাঠানো **বৈধ** — ধরনটা তুলে নেওয়ার একমাত্র পথ */
  @IsOptional() @IsIn(['designer', 'researcher', 'manager', null])
  staffType?: 'designer' | 'researcher' | 'manager' | null;

  @IsOptional() @IsInt() @Min(1)
  policyId?: number | null;

  /** ⭐ বদলালে আলাদা audit সারি বসে (targetType = `employee_salary`) */
  @IsOptional() @Matches(TAKA, { message: TAKA_MSG })
  monthlySalary?: string | null;

  @IsOptional() @Matches(DATE_ONLY)
  joinedOn?: string | null;

  /**
   * ⭐⭐ **এই ডিজাইনারের নিজের দৈনিক টার্গেট** *(২৩ আগস্ট ২০২৬)* — মালিকের
   * কথায়: *"karo daily target 25 ta, kono designer er daily target 15 ta"*।
   *
   * ⚠️ **খালি রাখলে পলিসির সংখ্যাটাই খাটে** (`work_policies`-এর ২৫), শূন্য নয়।
   * `null` পাঠিয়ে আগের মান মুছে পলিসিতে ফেরানো যায়।
   * ⚠️⚠️ **০ বৈধ** — "এর টার্গেট বন্ধ"; সংখ্যা গোনা চলবে, কিন্তু কেউ পিছিয়ে নয়।
   * ⚠️ ছাদ ৫০০ — টাইপো ধরার জন্য, নীতির জন্য নয় (পলিসির ঘরের মতোই)।
   */
  @IsOptional() @IsInt() @Min(0) @Max(500)
  dailyDesignTarget?: number | null;}
/**
 * `POST /employees/:id/policy-signed` — সই করা মনিটরিং পলিসির তারিখ।
 *
 * ⭐ **কেন আলাদা endpoint, `PATCH /employees/:id`-এর একটা ফিল্ড নয়:**
 * এটা কর্মীর তথ্য সম্পাদনা নয়, একটা **আইনি ঘটনা রেকর্ড করা** —
 * রোলআউটের একমাত্র শর্ত ([01 § রোলআউট](../../../docs/01-Planning.md))।
 * সাধারণ update-এর ভেতরে থাকলে সেটা `employee_update` audit-এ মিশে যেত,
 * আর "কার সই কবে নেওয়া হয়েছিল" আলাদা করে বের করা যেত না।
 *
 * ⚠️ **স্ক্যান আপলোড এখনো নেই** — শুধু তারিখ। `monitoring-policy-template.md`
 * "স্ক্যান করে ড্যাশবোর্ডে আপলোড" বলে; সেটা ভবিষ্যতের কাজ
 * (`upload_policy_doc` audit action ওর জন্যই তোলা আছে)।
 */
export class PolicySignedDto {
  /**
   * `YYYY-MM-DD`। না দিলে **আজকের ঢাকার তারিখ**।
   *
   * ⚠️ তারিখ দেওয়ার সুযোগ রাখা হয়েছে কারণ কাগজটা প্রায়ই আগে সই হয়,
   * আর ড্যাশবোর্ডে বসানো হয় দু-দিন পরে। বসানোর দিনটাকে সইয়ের দিন ধরে
   * নিলে রেকর্ডটা কাগজের সাথে মিলত না।
   */
  @IsOptional() @Matches(DATE_ONLY)
  signedOn?: string;
}
/**
 * ⚠️ ডিলিট নেই, deactivate আছে — কারো সারি মুছলে তার মাসের হিসাব,
 * স্ক্রিনশট আর audit trail সব অনাথ হয়ে যেত।
 */
export class DeactivateEmployeeDto {
  /** না দিলে ঢাকার আজকের তারিখ */
  @IsOptional() @Matches(DATE_ONLY, { message: 'leftOn must be in YYYY-MM-DD format' })
  leftOn?: string;

  @IsString() @MinLength(3) @MaxLength(500)
  reason!: string;
}
/** query-তে 'all'-ও লাগে, তাই Prisma-র enum সরাসরি ব্যবহার করা যায় না */
export const EMPLOYEE_STATUS_FILTERS = ['active', 'inactive', 'all'] as const;
export type EmployeeStatusFilter = (typeof EMPLOYEE_STATUS_FILTERS)[number];
export class EmployeeListQueryDto {
  /**
   * ডিফল্ট `active` — চলে যাওয়া লোকজন তালিকা ভরিয়ে রাখে না।
   *
   * ⚠️ এখানে `?includeInactive=true` ধাঁচের boolean রাখা হয়নি, কারণ
   * query string-এ সব কিছুই স্ট্রিং আর `Boolean('false')` = **true**।
   * ওই ফাঁদে পড়লে "চলে যাওয়া কর্মীদের বাদ দাও" চেকবক্সটা কখনোই কাজ করত না।
   */
  @IsOptional() @IsIn(EMPLOYEE_STATUS_FILTERS)
  status?: EmployeeStatusFilter;

  @IsOptional() @IsString() @MaxLength(120)
  search?: string;
}
