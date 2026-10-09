/** Strict Typert codecs shared by the Host and browser contribution artifacts. */
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol';
/**
 * This package's npm name, which the Typert host face is keyed by.
 *
 * `typert-loader` rejects a host manifest whose `package` differs from the
 * package that exports it ("the manifest must be owned by the package that
 * exports it"), and the registry rejects a duplicate `package` registration —
 * so this string has to be the real published name, not a display label.
 */
export declare const PACKAGE_NAME = "@whybebabo/dsh-file-review-tab";
export declare const FILE_REVIEW_INVOCATIONS: readonly InvocationDescriptor[];
//# sourceMappingURL=typert-descriptors.d.ts.map