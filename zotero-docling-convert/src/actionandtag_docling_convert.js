const Zotero = require("Zotero");
const window = require("window");
const Components = require("Components");

(async function () {
    if (window.doclingConvertRunning) return;
    window.doclingConvertRunning = true;

    try {
        // Use the items passed by Actions and Tags plugin
        if (!items && !item) {
            Zotero.alert(null, "Docling Convert", "No items provided to the script.");
            window.doclingConvertRunning = false;
            return;
        }

        // Convert single item to array
        let selectedItems = items || [item];

        if (!selectedItems.length) {
            Zotero.alert(null, "Docling Convert", "No items found to process.");
            window.doclingConvertRunning = false;
            return;
        }

        // Separate parent items and attachments without parent items
        const parentItems = selectedItems.filter(item => !item.isAttachment());
        const orphanAttachments = selectedItems.filter(item => item.isAttachment() && item.attachmentContentType === 'application/pdf');

        // Collect all PDF attachments
        const pdfAttachments = [];
        for (let item of parentItems) {
            const attachmentIDs = item.getAttachments();
            const attachments = await Zotero.Items.getAsync(attachmentIDs);
            for (let attachment of attachments) {
                if (attachment.attachmentContentType === 'application/pdf') {
                    pdfAttachments.push(attachment);
                }
            }
        }
        pdfAttachments.push(...orphanAttachments);

        if (pdfAttachments.length === 0) {
            Zotero.alert(null, "Docling Convert", "No PDF attachments found in the selected items.");
            window.doclingConvertRunning = false;
            return;
        }

        // Confirm the conversion operation
        const confirmation = window.confirm(`You are about to convert ${pdfAttachments.length} PDF attachments to Markdown using Docling.\n\nThis may take several minutes depending on the number and size of PDFs.\n\nDo you want to proceed?`);
        if (!confirmation) {
            Zotero.alert(null, "Docling Convert", "Conversion process cancelled.");
            window.doclingConvertRunning = false;
            return;
        }

        // Process conversions
        await convertPDFsToMarkdown(pdfAttachments);
        Zotero.alert(null, "Docling Convert", "Conversion process completed.");

    } catch (error) {
        Zotero.logError(`Error: ${error.message}`);
        Zotero.alert(null, "Docling Convert", `An error occurred: ${error.message}`);
    } finally {
        window.doclingConvertRunning = false;
    }

    // Function to execute docling command for a single PDF
    async function executeDocling(pdfPath) {
        return new Promise((resolve, reject) => {
            let bashFile = null;
            let process = null;

            try {
                const dir = pdfPath.substring(0, pdfPath.lastIndexOf('/'));
                const baseName = pdfPath.substring(pdfPath.lastIndexOf('/') + 1, pdfPath.lastIndexOf('.pdf'));

                // Create the bash script file
                bashFile = Components.classes["@mozilla.org/file/local;1"]
                    .createInstance(Components.interfaces.nsIFile);
                bashFile.initWithPath("/bin/zsh");

                // Use zsh with login shell to load .zshenv and .zshrc
                // The -l flag makes it a login shell, -c executes the command
                const command = `docling --to md --pipeline vlm --vlm-model granite_docling --output "${dir}" "${pdfPath}"`;

                const args = ["-l", "-c", command];

                // Create and execute process
                process = Components.classes["@mozilla.org/process/util;1"]
                    .createInstance(Components.interfaces.nsIProcess);
                process.init(bashFile);

                // Create observer for async process completion
                const observer = {
                    observe: function (subject, topic, data) {
                        if (topic === 'process-finished') {
                            const exitValue = subject.exitValue;
                            if (exitValue === 0) {
                                Zotero.log(`Successfully converted: ${pdfPath}`);
                                // Construct markdown path - docling creates filename.md from filename.pdf
                                const mdPath = `${dir}/${baseName}.md`;
                                Zotero.log(`Expected markdown path: ${mdPath}`);
                                resolve({ success: true, path: pdfPath, mdPath: mdPath });
                            } else {
                                Zotero.logError(`Failed to convert ${pdfPath}. Exit code: ${exitValue}`);
                                resolve({ success: false, path: pdfPath, exitCode: exitValue });
                            }
                        } else if (topic === 'process-failed') {
                            Zotero.logError(`Process failed for ${pdfPath}`);
                            resolve({ success: false, path: pdfPath, error: 'Process failed' });
                        }
                        // Clean up
                        bashFile = null;
                        process = null;
                    }
                };

                // Run asynchronously (non-blocking) - doesn't wait for completion
                process.runAsync(args, args.length, observer);

            } catch (error) {
                Zotero.logError(`Error processing ${pdfPath}: ${error.message}`);
                reject(error);
                // Clean up on error
                bashFile = null;
                process = null;
            }
        });
    }

    // Function to attach markdown file to parent item as a note using Better Notes
    async function attachMarkdownToItem(attachment, mdPath) {
        let mdFile = null;

        try {
            // Add a small delay to ensure file is written (async filesystem operations)
            await new Promise(resolve => setTimeout(resolve, 100));

            // Check if markdown file exists
            mdFile = Components.classes["@mozilla.org/file/local;1"]
                .createInstance(Components.interfaces.nsIFile);
            mdFile.initWithPath(mdPath);

            if (!mdFile.exists()) {
                Zotero.logError(`Markdown file not found: ${mdPath}`);
                // Try to list files in the directory to debug
                const dir = mdPath.substring(0, mdPath.lastIndexOf('/'));
                const dirFile = Components.classes["@mozilla.org/file/local;1"]
                    .createInstance(Components.interfaces.nsIFile);
                dirFile.initWithPath(dir);
                if (dirFile.exists() && dirFile.isDirectory()) {
                    const entries = dirFile.directoryEntries;
                    Zotero.log(`Directory contents of ${dir}:`);
                    while (entries.hasMoreElements()) {
                        const entry = entries.getNext().QueryInterface(Components.interfaces.nsIFile);
                        if (entry.leafName.endsWith('.md')) {
                            Zotero.log(`  Found .md file: ${entry.leafName}`);
                        }
                    }
                }
                return false;
            }

            // Get parent item
            const parentItemID = attachment.parentItemID;
            if (!parentItemID) {
                Zotero.log(`No parent item for attachment ${attachment.id}, skipping markdown note creation`);
                return false;
            }

            const parentItem = await Zotero.Items.getAsync(parentItemID);
            if (!parentItem) {
                Zotero.logError(`Parent item not found for attachment ${attachment.id}`);
                return false;
            }

            // Check if Better Notes plugin is available
            if (!Zotero.BetterNotes || !Zotero.BetterNotes.api || !Zotero.BetterNotes.api.$import) {
                Zotero.logError("Better Notes plugin not found. Please install it from: https://github.com/windingwind/zotero-better-notes");
                return false;
            }

            const mdFileName = mdPath.substring(mdPath.lastIndexOf('/') + 1);

            // Check if a note with this name already exists
            const existingNotes = Zotero.Items.get(parentItem.getNotes());
            for (let note of existingNotes) {
                const noteTitle = note.getNoteTitle();
                if (noteTitle && noteTitle.includes(mdFileName.replace('.md', ''))) {
                    Zotero.log(`Note already exists for: ${mdFileName}`);
                    return true;
                }
            }

            // Create a new note as a child of the parent item
            const noteItem = new Zotero.Item('note');
            noteItem.libraryID = parentItem.libraryID;
            noteItem.parentID = parentItemID;
            await noteItem.saveTx();

            // Import the markdown file into the note using Better Notes API
            await Zotero.BetterNotes.api.$import.fromMD(mdPath, {
                noteId: noteItem.id,
                ignoreVersion: true,
                append: false
            });

            Zotero.log(`Created note from markdown: ${mdFileName}`);
            return true;

        } catch (error) {
            Zotero.logError(`Error creating note from markdown: ${error.message}`);
            return false;
        } finally {
            // Clean up file reference
            mdFile = null;
        }
    }

    // Function to convert PDFs to Markdown
    async function convertPDFsToMarkdown(attachments) {
        let successCount = 0;
        let errorCount = 0;
        let notesCreatedCount = 0;
        const errors = [];

        for (let i = 0; i < attachments.length; i++) {
            const attachment = attachments[i];

            try {
                // Skip linked URL attachments
                if (attachment.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_URL) {
                    Zotero.log(`Skipping linked URL attachment: ${attachment.id}`);
                    continue;
                }

                const filePath = await attachment.getFilePathAsync();
                if (!filePath) {
                    Zotero.logError(`No file path for attachment ${attachment.id}`);
                    errorCount++;
                    continue;
                }

                Zotero.log(`Processing ${i + 1}/${attachments.length}: ${filePath}`);

                const result = await executeDocling(filePath);

                if (result.success) {
                    successCount++;

                    // Try to create a note from the markdown file
                    if (result.mdPath) {
                        const created = await attachMarkdownToItem(attachment, result.mdPath);
                        if (created) {
                            notesCreatedCount++;
                        }
                    }
                } else {
                    errorCount++;
                    errors.push({ path: filePath, exitCode: result.exitCode });
                }

                // Periodically yield to event loop to keep UI responsive
                if (i % 5 === 0) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                }

            } catch (error) {
                Zotero.logError(`Error processing attachment ${attachment.id}: ${error.message}`);
                errorCount++;
                errors.push({ path: attachment.id, error: error.message });
            }
        }

        Zotero.log(`Conversion complete: ${successCount} successful, ${errorCount} errors, ${notesCreatedCount} notes created`);

        if (errors.length > 0) {
            Zotero.log("Errors encountered:");
            errors.forEach(err => {
                Zotero.log(`  - ${err.path}: ${err.exitCode || err.error}`);
            });
        }
    }

})();
