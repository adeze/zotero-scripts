(async function () {
    const startTime = performance.now();

    try {
        const zoteroPane = Zotero.getActiveZoteroPane();

        // Prompt user for items scope
        const editOption = await getValidEditOption();
        if (!editOption) return;

        // Retrieve items based on user selection
        const items = await getItemsToEdit(editOption, zoteroPane);
        if (!items || !items.length) {
            alert("No items found.");
            return;
        }

        // Separate parent items and attachments without parent items
        const parentItems = items.filter(item => !item.isAttachment());
        const orphanAttachments = items.filter(item => item.isAttachment() && item.attachmentContentType === 'application/pdf');

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
            alert("No PDF attachments found in the selected items.");
            return;
        }

        // Confirm the conversion operation
        const confirmation = confirm(`You are about to convert ${pdfAttachments.length} PDF attachments to Markdown using Docling.\n\nThis may take several minutes depending on the number and size of PDFs.\n\nDo you want to proceed?`);
        if (!confirmation) {
            alert("Conversion process cancelled.");
            return;
        }

        // Process conversions
        await convertPDFsToMarkdown(pdfAttachments);
        alert("Conversion process completed.");

    } catch (error) {
        console.error(`Error: ${error.message}`);
        alert(`An error occurred: ${error.message}`);
    } finally {
        const endTime = performance.now();
        logTime("Total time", endTime - startTime);
    }

    // Logs the time taken for a specific operation
    function logTime(label, time) {
        try {
            console.log(`${label}: ${(time / 1000).toFixed(2)} seconds`);
        } catch (error) {
            console.error(`Failed to log time for ${label}: ${error.message}`);
        }
    }

    // Function to get a valid input for the scope of items to edit
    async function getValidEditOption() {
        while (true) {
            const editOption = prompt("Enter '1' to process selected items, '2' for items in the current collection, or '3' for items in a saved search:");

            // Sanitize the user input
            const sanitizedEditOption = editOption ? editOption.trim() : null;

            if (sanitizedEditOption === null) {
                alert("Operation canceled.");
                return null;
            }

            if (['1', '2', '3'].includes(sanitizedEditOption)) {
                return sanitizedEditOption;
            } else {
                alert(`Invalid option: "${sanitizedEditOption}". Please enter '1', '2', or '3'.`);
            }
        }
    }

    // Function to retrieve items based on user selection
    async function getItemsToEdit(editOption, zoteroPane) {
        if (editOption === '2') {
            let collection = zoteroPane.getSelectedCollection();
            if (!collection) {
                alert("No collection selected.");
                return null;
            }
            return await collection.getChildItems();
        } else if (editOption === '3') {
            let savedSearch = zoteroPane.getSelectedSavedSearch();
            if (!savedSearch) {
                alert("No saved search selected.");
                return null;
            }
            let search = new Zotero.Search();
            search.libraryID = savedSearch.libraryID;
            search.addCondition('savedSearchID', 'is', savedSearch.id);
            let itemIDs = await search.search();
            if (itemIDs.length === 0) {
                alert("No items found in the saved search.");
                return null;
            }
            return await Zotero.Items.getAsync(itemIDs);
        } else {
            let selectedItems = zoteroPane.getSelectedItems();
            if (!selectedItems.length) {
                alert("No items selected.");
                return null;
            }
            return selectedItems;
        }
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
                                console.log(`Successfully converted: ${pdfPath}`);
                                // Construct markdown path - docling creates filename.md from filename.pdf
                                const mdPath = `${dir}/${baseName}.md`;
                                console.log(`Expected markdown path: ${mdPath}`);
                                resolve({ success: true, path: pdfPath, mdPath: mdPath });
                            } else {
                                console.error(`Failed to convert ${pdfPath}. Exit code: ${exitValue}`);
                                resolve({ success: false, path: pdfPath, exitCode: exitValue });
                            }
                        } else if (topic === 'process-failed') {
                            console.error(`Process failed for ${pdfPath}`);
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
                console.error(`Error processing ${pdfPath}: ${error.message}`);
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
                console.error(`Markdown file not found: ${mdPath}`);
                // Try to list files in the directory to debug
                const dir = mdPath.substring(0, mdPath.lastIndexOf('/'));
                const dirFile = Components.classes["@mozilla.org/file/local;1"]
                    .createInstance(Components.interfaces.nsIFile);
                dirFile.initWithPath(dir);
                if (dirFile.exists() && dirFile.isDirectory()) {
                    const entries = dirFile.directoryEntries;
                    console.log(`Directory contents of ${dir}:`);
                    while (entries.hasMoreElements()) {
                        const entry = entries.getNext().QueryInterface(Components.interfaces.nsIFile);
                        if (entry.leafName.endsWith('.md')) {
                            console.log(`  Found .md file: ${entry.leafName}`);
                        }
                    }
                }
                return false;
            }

            // Get parent item
            const parentItemID = attachment.parentItemID;
            if (!parentItemID) {
                console.log(`No parent item for attachment ${attachment.id}, skipping markdown note creation`);
                return false;
            }

            const parentItem = await Zotero.Items.getAsync(parentItemID);
            if (!parentItem) {
                console.error(`Parent item not found for attachment ${attachment.id}`);
                return false;
            }

            // Check if Better Notes plugin is available
            if (!Zotero.BetterNotes || !Zotero.BetterNotes.api || !Zotero.BetterNotes.api.$import) {
                console.error("Better Notes plugin not found. Please install it from: https://github.com/windingwind/zotero-better-notes");
                return false;
            }

            const mdFileName = mdPath.substring(mdPath.lastIndexOf('/') + 1);

            // Check if a note with this name already exists
            const existingNotes = Zotero.Items.get(parentItem.getNotes());
            for (let note of existingNotes) {
                const noteTitle = note.getNoteTitle();
                if (noteTitle && noteTitle.includes(mdFileName.replace('.md', ''))) {
                    console.log(`Note already exists for: ${mdFileName}`);
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

            console.log(`Created note from markdown: ${mdFileName}`);
            return true;

        } catch (error) {
            console.error(`Error creating note from markdown: ${error.message}`);
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
                    console.log(`Skipping linked URL attachment: ${attachment.id}`);
                    continue;
                }

                const filePath = await attachment.getFilePathAsync();
                if (!filePath) {
                    console.error(`No file path for attachment ${attachment.id}`);
                    errorCount++;
                    continue;
                }

                console.log(`Processing ${i + 1}/${attachments.length}: ${filePath}`);

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
                console.error(`Error processing attachment ${attachment.id}: ${error.message}`);
                errorCount++;
                errors.push({ path: attachment.id, error: error.message });
            }
        }

        console.log(`Conversion complete: ${successCount} successful, ${errorCount} errors, ${notesCreatedCount} notes created`);

        if (errors.length > 0) {
            console.log("Errors encountered:");
            errors.forEach(err => {
                console.log(`  - ${err.path}: ${err.exitCode || err.error}`);
            });
        }

        // Show summary
        alert(`Conversion complete:\n\nSuccessful: ${successCount}\nErrors: ${errorCount}\nNotes created: ${notesCreatedCount}\n\nCheck the console for details.`);
    }

})();
