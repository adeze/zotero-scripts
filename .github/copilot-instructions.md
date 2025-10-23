# Zotero Scripts Development Guide

## Project Overview

This is a collection of JavaScript utilities designed to extend Zotero 7 with batch/bulk operations for library management. Each script exists in two variants:

- **Run Javascript scripts**: Standalone files executed via Zotero's `Tools > Developer > Run JavaScript` console
- **Actions and Tags scripts**: Integration files prefixed with `actionandtag_` for the [Actions and Tags plugin](https://github.com/windingwind/zotero-actions-tags)

## Architecture

### Directory Structure

Each tool lives in its own directory with consistent layout:

```
zotero-{feature-name}/
├── README.md              # User documentation with screenshots
├── doc/                   # Screenshots and images
└── src/
    ├── {feature}.js       # Standalone script
    └── actionandtag_{feature}.js  # Plugin variant
```

### Script Variants

**Standalone scripts** (`*.js`):

- Use IIFE wrapper: `(async function() { ... })()`
- Access global `Zotero` object directly
- Use `alert()`, `prompt()`, `confirm()` for UI dialogs
- Use `console.log()` and `console.error()` for logging
- Access `window` and `Components` interfaces directly
- See: `zotero-attachment-backup/src/attachment_backup.js`

**Actions and Tags scripts** (`actionandtag_*.js`):

- Require dependencies: `const Zotero = require("Zotero")`, `const window = require("window")`
- Use global flag to prevent concurrent runs: `if (window.{scriptName}Running) return;`
- Use `Zotero.alert(null, "Title", "Message")` instead of `alert()`
- Use `Zotero.logError()` instead of `console.error()`
- Must clean up flag in `finally` block
- See: `zotero-attachment-backup/src/actionandtag_attachment_backup.js`

## Common Patterns

### Item Selection Scope

All scripts follow this pattern for selecting items to process:

```javascript
// Option 1: Selected items
const selectedItems = zoteroPane.getSelectedItems();

// Option 2: Current collection
const collection = zoteroPane.getSelectedCollection();
const items = await collection.getChildItems();

// Option 3: Saved search
const savedSearch = zoteroPane.getSelectedSavedSearch();
const search = new Zotero.Search();
search.libraryID = savedSearch.libraryID;
search.addCondition("savedSearchID", "is", savedSearch.id);
const itemIDs = await search.search();
const items = await Zotero.Items.getAsync(itemIDs);
```

### Input Validation

Use `while(true)` loops with sanitization and explicit validation:

```javascript
async function getValidEditOption() {
  while (true) {
    const editOption = prompt("Enter '1', '2', or '3':");
    const sanitized = editOption ? editOption.trim() : null;
    if (sanitized === null) {
      alert("Operation canceled.");
      return null;
    }
    if (["1", "2", "3"].includes(sanitized)) {
      return sanitized;
    }
    alert(`Invalid option: "${sanitized}". Please try again.`);
  }
}
```

### Performance Timing

Log execution time for all major operations:

```javascript
const startTime = performance.now();
// ... operations ...
const endTime = performance.now();
logTime("Total time", endTime - startTime);

function logTime(label, time) {
  console.log(`${label}: ${(time / 1000).toFixed(2)} seconds`);
}
```

### Attachment Handling

```javascript
// Get attachments for a parent item
const attachmentIDs = item.getAttachments();
const attachments = await Zotero.Items.getAsync(attachmentIDs);

// Check if item is an attachment
if (item.isAttachment()) { ... }

// Get attachment file path
const filePath = await attachment.getFilePathAsync();

// Skip linked URL attachments (no local files)
if (attachment.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_URL) {
    continue;
}
```

### Transaction Management

Always use transactions for data modifications:

```javascript
await item.saveTx(); // Save with transaction
```

### Duplicate Prevention

Track processed items to avoid duplicate operations:

```javascript
const processedAttachmentIds = new Set();
if (processedAttachmentIds.has(attachment.id)) continue;
processedAttachmentIds.add(attachment.id);
```

## Key APIs

- **Zotero.getActiveZoteroPane()**: Access to UI selection context
- **Zotero.Items.getAsync(ids)**: Batch load items by IDs
- **Components.interfaces.nsIFilePicker**: File/folder selection dialogs
- **item.getField(fieldName)** / **item.setField(fieldName, value)**: Metadata access
- **item.getAttachments()**: Returns array of attachment IDs for parent items
- **Zotero.FileHandlers**: For file operations (copy, move)

## Conventions

- **Error Handling**: Wrap main logic in try-catch with user-friendly error messages
- **User Confirmation**: Always confirm destructive operations (delete, replace, bulk modify)
- **Logging**: Provide detailed progress feedback, especially for long operations
- **Field Definitions**: Include complete field/type definition arrays (see `zotero_bulk_edit.js` lines 4-120)
- **Custom Dictionaries**: Support user-defined overrides (e.g., `customCapitalization` in `zotero-text-case.js`)

## Development Workflow

1. **No build system**: Plain JavaScript, no transpilation or bundling
2. **Testing**: Manual testing via Zotero's Run JavaScript console
3. **Documentation**: Each feature requires README.md with screenshots in `doc/` folder
4. **Dual Implementation**: When adding features, maintain both standalone and Actions and Tags variants
