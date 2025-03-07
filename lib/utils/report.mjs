import {
	isFunction as isFn,
	isNumber,
	isPlainObject,
	isRange,
	isString,
} from '../utils/validateTypes.mjs';

import {
	DEFAULT_SEVERITY,
	RULE_NAME_ALL,
	SEVERITY_ERROR,
	SEVERITY_WARNING,
} from '../constants.mjs';
import emitDeprecationWarning from './emitDeprecationWarning.mjs';

/** @import { DisabledRangeObject, Problem, Range, RuleMessage, StylelintPostcssResult, Utils, WarningOptions } from 'stylelint' */

/**
 * Report a problem.
 *
 * This function accounts for `disabledRanges` attached to the result.
 * That is, if the reported problem is within a disabledRange,
 * it is ignored. Otherwise, it is attached to the result as a
 * postcss warning.
 *
 * It also accounts for the rule's severity.
 *
 * You *must* pass *either* a node or a line number.
 *
 * @type {Utils['report']}
 */
export default function report(problem) {
	const { node, index, endIndex, line, start, end, result, ruleName, word, fix, ...rest } = problem;

	checkProblemRangeDeprecations(problem);

	const {
		disabledRanges,
		quiet,
		ruleSeverities,
		config: { defaultSeverity, ignoreDisables } = {},
		customMessages: { [ruleName]: message = rest.message },
		customUrls: { [ruleName]: customUrl },
		ruleMetadata: { [ruleName]: metadata },
	} = result.stylelint;
	const { messageArgs = [], severity = ruleSeverities[ruleName] } = rest;
	const ruleSeverity =
		(isFn(severity) ? severity(...messageArgs) : severity) ?? defaultSeverity ?? DEFAULT_SEVERITY;

	// In quiet mode, mere warnings are ignored
	if (quiet && ruleSeverity === SEVERITY_WARNING) return;

	if (isFn(fix) && metadata && !metadata.fixable) {
		throw new Error(
			`The "${ruleName}" rule requires "meta.fixable" to be truthy if the "fix" callback is being passed`,
		);
	}

	// If a line is not passed, use the node.rangeBy method to get the
	// line number that the complaint pertains to
	const startLine = line ?? node?.rangeBy({ index, endIndex }).start.line;

	if (!startLine) {
		throw new Error(
			`The "${ruleName}" rule failed to pass either a node or a line number to the \`report()\` function.`,
		);
	}

	if (isFixApplied({ ...problem, line: startLine })) return;

	if (isDisabled(ruleName, startLine, disabledRanges)) {
		// Collect disabled warnings
		// Used to report `needlessDisables` in subsequent processing.
		const disabledWarnings = (result.stylelint.disabledWarnings ||= []);

		disabledWarnings.push({
			rule: ruleName,
			line: startLine,
		});

		if (!ignoreDisables) return;
	}

	if (!result.stylelint.stylelintError && ruleSeverity === SEVERITY_ERROR) {
		result.stylelint.stylelintError = true;
	}

	if (!result.stylelint.stylelintWarning && ruleSeverity === SEVERITY_WARNING) {
		result.stylelint.stylelintWarning = true;
	}

	/** @type {WarningOptions} */
	const warningProperties = {
		severity: ruleSeverity,
		rule: ruleName,
	};

	if (node) {
		warningProperties.node = node;
	}

	if (start) {
		warningProperties.start = start;
	} else if (isNumber(index)) {
		warningProperties.index = index;
	}

	if (end) {
		warningProperties.end = end;
	} else if (isNumber(endIndex)) {
		warningProperties.endIndex = endIndex;
	}

	if (word) {
		warningProperties.word = word;
	}

	if (customUrl) {
		warningProperties.url = customUrl;
	}

	const warningMessage = buildWarningMessage(message, messageArgs);

	result.warn(warningMessage, warningProperties);
}

/**
 * @param {Problem} problem
 */
function checkProblemRangeDeprecations(problem) {
	if (problem.result.stylelint.quietDeprecationWarnings) return;

	if (!problem.node) {
		emitDeprecationWarning(
			`Omitting the \`node\` argument in the \`utils.report()\` function is deprecated ("${problem.ruleName}").`,
			'REPORT_AMBIGUOUS_POSITION',
			`Please pass a \`node\` argument in the \`utils.report()\` function of "${problem.ruleName}".`,
		);
	}

	if (!isRange(problem) && ('start' in problem || 'end' in problem)) {
		emitDeprecationWarning(
			`Partial position information in the \`utils.report()\` function is deprecated ("${problem.ruleName}").`,
			'REPORT_AMBIGUOUS_POSITION',
			`Please pass both a valid \`start\` and \`end\` argument in the \`utils.report()\` function of "${problem.ruleName}".`,
		);
	}

	if (!hasIndices(problem) && ('index' in problem || 'endIndex' in problem)) {
		emitDeprecationWarning(
			`Partial position information in the \`utils.report()\` function is deprecated ("${problem.ruleName}").`,
			'REPORT_AMBIGUOUS_POSITION',
			`Please pass both \`index\` and \`endIndex\` as arguments in the \`utils.report()\` function of "${problem.ruleName}".`,
		);
	}

	if ('line' in problem) {
		emitDeprecationWarning(
			`Providing the \`line\` argument in the \`utils.report()\` function is deprecated ("${problem.ruleName}").`,
			'REPORT_AMBIGUOUS_POSITION',
			`Please pass both \`index\` and \`endIndex\` as arguments in the \`utils.report()\` function of "${problem.ruleName}" instead.`,
		);
	}
}

/**
 * @param {RuleMessage} message
 * @param {NonNullable<Problem['messageArgs']>} messageArgs
 * @returns {string}
 */
function buildWarningMessage(message, messageArgs) {
	if (isString(message)) {
		return printfLike(message, ...messageArgs);
	}

	return message(...messageArgs);
}

/**
 * @param {string} format
 * @param {Array<unknown>} args
 * @returns {string}
 */
function printfLike(format, ...args) {
	return args.reduce((/** @type {string} */ result, arg) => {
		return result.replace(/%[ds]/, String(arg));
	}, format);
}

/**
 * Check whether a rule is disabled for a given line
 * @param {string} ruleName
 * @param {number} startLine
 * @param {DisabledRangeObject} disabledRanges
 */
function isDisabled(ruleName, startLine, disabledRanges) {
	const ranges = disabledRanges[ruleName] ?? disabledRanges[RULE_NAME_ALL] ?? [];

	for (const range of ranges) {
		if (
			// If the problem is within a disabledRange,
			// and that disabledRange's rules include this one
			range.start <= startLine &&
			(range.end === undefined || range.end >= startLine) &&
			/** @todo populate rules in assignDisabledRanges util */
			(!range.rules || range.rules.includes(ruleName))
		) {
			return true;
		}
	}

	return false;
}

/** @param {Problem & { line: number }} problem */
function isFixApplied({ fix, line, result: { stylelint }, ruleName }) {
	const { disabledRanges, config = {}, fixersData } = stylelint;

	if (!isFn(fix)) {
		return false;
	}

	const shouldFix = Boolean(config.fix && !config.rules?.[ruleName][1]?.disableFix);
	const mayFix =
		shouldFix && (config.ignoreDisables || !isDisabled(ruleName, line, disabledRanges));

	if (!mayFix) return false;

	fix();

	incrementFixCounter({ fixersData, ruleName });

	return true;
}

/**
 * @param {object} o
 * @param {StylelintPostcssResult['fixersData']} o.fixersData
 * @param {string} o.ruleName
 */
function incrementFixCounter({ fixersData, ruleName }) {
	fixersData[ruleName] ??= 0;
	fixersData[ruleName]++;
}

/**
 * @param {unknown} value
 * @returns {value is { index: number, endIndex: number }}
 */
function hasIndices(value) {
	if (!isPlainObject(value)) return false;

	if (!isNumber(value.index)) return false;

	if (!isNumber(value.endIndex)) return false;

	return true;
}
