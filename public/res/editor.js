/* jshint -W084, -W099 */
define([
    'jquery',
    'underscore',
    'settings',
    'eventMgr',
    'prism-core',
    'diff_match_patch_uncompressed',
    'jsondiffpatch',
    'crel',
    'MutationObservers',
    'libs/prism-markdown'
], function ($, _, settings, eventMgr, Prism, diff_match_patch, jsondiffpatch, crel) {

    function strSplice(str, i, remove, add) {
        remove = +remove || 0;
        add = add || '';
        return str.slice(0, i) + add + str.slice(i + remove);
    }

    var editor = {};
    var scrollTop = 0;
    var inputElt;
    var $inputElt;
    var contentElt;
    var $contentElt;
    var marginElt;
    var $marginElt;
    var previewElt;
    var pagedownEditor;
    var refreshPreviewLater = (function() {
        var elapsedTime = 0;
        var refreshPreview = function() {
            var startTime = Date.now();
            pagedownEditor.refreshPreview();
            elapsedTime = Date.now() - startTime;
        };
        if(settings.lazyRendering === true) {
            return _.debounce(refreshPreview, 500);
        }
        return function() {
            setTimeout(refreshPreview, elapsedTime < 2000 ? elapsedTime : 2000);
        };
    })();
    eventMgr.addListener('onPagedownConfigure', function(editor) {
        pagedownEditor = editor;
    });

    eventMgr.addListener('onSectionsCreated', function(newSectionList) {
        updateSectionList(newSectionList);
        highlightSections();
        if(fileChanged === true) {
            // Refresh preview synchronously
            pagedownEditor.refreshPreview();
        }
        else {
            refreshPreviewLater();
        }
    });

    var fileChanged = true;
    var fileDesc;
    eventMgr.addListener('onFileSelected', function(selectedFileDesc) {
        fileChanged = true;
        fileDesc = selectedFileDesc;
    });

    // Watcher used to detect editor changes
    function Watcher() {
        this.isWatching = false;
        var contentObserver;
        this.startWatching = function() {
            this.isWatching = true;
            contentObserver = contentObserver || new MutationObserver(checkContentChange);
            contentObserver.observe(contentElt, {
                childList: true,
                subtree: true,
                characterData: true
            });
        };
        this.stopWatching = function() {
            contentObserver.disconnect();
            this.isWatching = false;
        };
        this.noWatch = function(cb) {
            if(this.isWatching === true) {
                this.stopWatching();
                cb();
                this.startWatching();
            }
            else {
                cb();
            }
        };
    }
    var watcher = new Watcher();
    editor.watcher = watcher;

    var diffMatchPatch = new diff_match_patch();
    var jsonDiffPatch = jsondiffpatch.create({
        objectHash: function(obj) {
            return JSON.stringify(obj);
        },
        arrays: {
            detectMove: false,
        },
        textDiff: {
            minLength: 9999999
        }
    });

    function SelectionMgr() {
        this.selectionStart = 0;
        this.selectionEnd = 0;
        this.cursorY = 0;
        this.findOffset = function(offset) {
            var walker = document.createTreeWalker(contentElt, 4);
            while(walker.nextNode()) {
                var text = walker.currentNode.nodeValue || '';
                if (text.length > offset) {
                    return {
                        container: walker.currentNode,
                        offset: offset
                    };
                }
                offset -= text.length;
            }
            return {
                container: contentElt,
                offset: 0
            };
        };
        this.createRange = function(start, end) {
            var range = document.createRange();
            var offset = _.isObject(start) ? start : this.findOffset(start);
            range.setStart(offset.container, offset.offset);
            if (end && end != start) {
                offset = _.isObject(end) ? end : this.findOffset(end);
            }
            range.setEnd(offset.container, offset.offset);
            return range;
        };
        this.setSelectionStartEnd = function(start, end, range, skipSelectionUpdate) {
            if(start === undefined) {
                start = this.selectionStart;
            }
            if(end === undefined) {
                end = this.selectionEnd;
            }
            var min = Math.min(start, end);
            var max = Math.max(start, end);
            range = range || this.createRange(min, max);
            if(start < end || !skipSelectionUpdate) {
                this.selectionStart = min;
                this.selectionEnd = max;
            }
            else {
                this.selectionStart = max;
                this.selectionEnd = min;
            }
            if(!skipSelectionUpdate) {
                var selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
            }
            fileDesc.editorStart = this.selectionStart;
            fileDesc.editorEnd = this.selectionEnd;
            // Update cursor coordinates
            $inputElt.toggleClass('has-selection', this.selectionStart !== this.selectionEnd);
            var coordinates = this.getCoordinates(this.selectionEnd, this.selectionEndContainer, this.selectionEndOffset);
            if(this.cursorY !== coordinates.y) {
                this.cursorY = coordinates.y;
                eventMgr.onCursorCoordinates(coordinates.x, coordinates.y);
            }
            return range;
        };
        this.saveSelectionState = function(skipSelectionUpdate) {
            if(fileChanged === false) {
                var selection = window.getSelection();
                if(!skipSelectionUpdate && selection.rangeCount > 0) {
                    var range = selection.getRangeAt(0);
                    var element = range.startContainer;

                    if ((inputElt.compareDocumentPosition(element) & 0x10)) {
                        var container = element;
                        var offset = range.startOffset;
                        do {
                            while (element = element.previousSibling) {
                                if (element.textContent) {
                                    offset += element.textContent.length;
                                }
                            }

                            element = container = container.parentNode;
                        } while (element && element != inputElt);

                        // Determine if it's a backward selection
                        var isBackwardSelection = false;
                        if (!selection.isCollapsed) {
                            var tmpRange = document.createRange();
                            tmpRange.setStart(selection.anchorNode, selection.anchorOffset);
                            tmpRange.setEnd(selection.focusNode, selection.focusOffset);
                            isBackwardSelection = tmpRange.collapsed;
                            tmpRange.detach();
                        }

                        if(isBackwardSelection) {
                            this.setSelectionStartEnd(offset + (range + '').length, offset, range, true);
                        }
                        else {
                            this.setSelectionStartEnd(offset, offset + (range + '').length, range, true);
                        }
                    }
                }
            }
            undoMgr.saveSelectionState();
        };
        this.getCoordinates = function(inputOffset, container, offset) {
            if(!container) {
                offset = this.findOffset(inputOffset);
                container = offset.container;
                offset = offset.offset;
            }
            var x = 0;
            var y = 0;
            if(container.textContent == '\n') {
                y = container.parentNode.offsetTop + container.parentNode.offsetHeight / 2;
            }
            else {
                var selectedChar = textContent[inputOffset];
                var startOffset = {
                    container: container,
                    offset: offset
                };
                var endOffset = {
                    container: container,
                    offset: offset
                };
                if(selectedChar === undefined || selectedChar == '\n') {
                    if(startOffset.offset === 0) {
                        startOffset = inputOffset - 1;
                    }
                    else {
                        startOffset.offset -= 1;
                    }
                }
                else {
                    if(endOffset.offset === container.textContent.length) {
                        endOffset = inputOffset + 1;
                    }
                    else {
                        endOffset.offset += 1;
                    }
                }
                var selectionRange = this.createRange(startOffset, endOffset);
                var selectionRect = selectionRange.getBoundingClientRect();
                y = selectionRect.top + selectionRect.height / 2 - inputElt.offsetTop + inputElt.scrollTop;
                selectionRange.detach();
            }
            return {
                x: x,
                y: y
            };
        };
    }
    var selectionMgr = new SelectionMgr();
    editor.selectionMgr = selectionMgr;

    var adjustCursorPosition = _.debounce(function() {
        if(inputElt === undefined) {
            return;
        }
        selectionMgr.saveSelectionState();

        var adjust = inputElt.offsetHeight / 2;
        if(adjust > 130) {
            adjust = 130;
        }
        var cursorMinY = inputElt.scrollTop + adjust;
        var cursorMaxY = inputElt.scrollTop + inputElt.offsetHeight - adjust;
        if(selectionMgr.cursorY < cursorMinY) {
            inputElt.scrollTop += selectionMgr.cursorY - cursorMinY;
        }
        else if(selectionMgr.cursorY > cursorMaxY) {
            inputElt.scrollTop += selectionMgr.cursorY - cursorMaxY;
        }
    }, 0);
    eventMgr.addListener('onLayoutResize', adjustCursorPosition);

    var textContent;
    function setValue(value) {
        var startOffset = diffMatchPatch.diff_commonPrefix(textContent, value);
        var endOffset = Math.min(
            diffMatchPatch.diff_commonSuffix(textContent, value),
            textContent.length - startOffset,
            value.length - startOffset
        );
        var replacement = value.substring(startOffset, value.length - endOffset);
        var range = selectionMgr.createRange(startOffset, textContent.length - endOffset);
        range.deleteContents();
        range.insertNode(document.createTextNode(replacement));
    }

    function setValueNoWatch(value) {
        setValue(value);
        textContent = value;
    }
    editor.setValueNoWatch = setValueNoWatch;

    function getValue() {
        return textContent;
    }
    editor.setValueNoWatch = getValue;

    function UndoMgr() {
        var undoStack = [];
        var redoStack = [];
        var lastTime;
        var lastMode;
        var currentState;
        var selectionStartBefore;
        var selectionEndBefore;
        this.setCommandMode = function() {
            this.currentMode = 'command';
        };
        this.setMode = function() {}; // For compatibility with PageDown
        this.onButtonStateChange = function() {}; // To be overridden by PageDown
        this.saveState = _.debounce(function() {
            redoStack = [];
            var currentTime = Date.now();
            if(this.currentMode == 'comment' || (this.currentMode != lastMode && lastMode != 'newlines') || currentTime - lastTime > 1000) {
                undoStack.push(currentState);
                // Limit the size of the stack
                if(undoStack.length === 100) {
                    undoStack.shift();
                }
            }
            else {
                selectionStartBefore = currentState.selectionStartBefore;
                selectionEndBefore = currentState.selectionEndBefore;
            }
            currentState = {
                selectionStartBefore: selectionStartBefore,
                selectionEndBefore: selectionEndBefore,
                selectionStartAfter: selectionMgr.selectionStart,
                selectionEndAfter: selectionMgr.selectionEnd,
                content: textContent,
                discussionListJSON: fileDesc.discussionListJSON
            };
            lastTime = currentTime;
            lastMode = this.currentMode;
            this.currentMode = undefined;
            this.onButtonStateChange();
        }, 0);
        this.saveSelectionState = _.debounce(function() {
            if(this.currentMode === undefined) {
                selectionStartBefore = selectionMgr.selectionStart;
                selectionEndBefore = selectionMgr.selectionEnd;
            }
        }, 10);
        this.canUndo = function() {
            return undoStack.length;
        };
        this.canRedo = function() {
            return redoStack.length;
        };
        var self = this;
        function restoreState(state, selectionStart, selectionEnd) {
            // Update editor
            watcher.noWatch(function() {
                if(textContent != state.content) {
                    setValueNoWatch(state.content);
                    fileDesc.content = state.content;
                    eventMgr.onContentChanged(fileDesc, state.content);
                }
                selectionMgr.setSelectionStartEnd(selectionStart, selectionEnd);
                var discussionListJSON = fileDesc.discussionListJSON;
                if(discussionListJSON != state.discussionListJSON) {
                    var oldDiscussionList = fileDesc.discussionList;
                    fileDesc.discussionListJSON = state.discussionListJSON;
                    var newDiscussionList = fileDesc.discussionList;
                    var diff = jsonDiffPatch.diff(oldDiscussionList, newDiscussionList);
                    var commentsChanged = false;
                    _.each(diff, function(discussionDiff, discussionIndex) {
                        if(!_.isArray(discussionDiff)) {
                            commentsChanged = true;
                        }
                        else if(discussionDiff.length === 1) {
                            eventMgr.onDiscussionCreated(fileDesc, newDiscussionList[discussionIndex]);
                        }
                        else {
                            eventMgr.onDiscussionRemoved(fileDesc, oldDiscussionList[discussionIndex]);
                        }
                    });
                    commentsChanged && eventMgr.onCommentsChanged(fileDesc);
                }
            });

            selectionStartBefore = selectionStart;
            selectionEndBefore = selectionEnd;
            currentState = state;
            self.currentMode = undefined;
            lastMode = undefined;
            self.onButtonStateChange();
            adjustCursorPosition();
        }
        this.undo = function() {
            var state = undoStack.pop();
            if(!state) {
                return;
            }
            redoStack.push(currentState);
            restoreState(state, currentState.selectionStartBefore, currentState.selectionEndBefore);
        };
        this.redo = function() {
            var state = redoStack.pop();
            if(!state) {
                return;
            }
            undoStack.push(currentState);
            restoreState(state, state.selectionStartAfter, state.selectionEndAfter);
        };
        this.init = function() {
            var content = fileDesc.content;
            undoStack = [];
            redoStack = [];
            lastTime = 0;
            currentState = {
                selectionStartAfter: fileDesc.selectionStart,
                selectionEndAfter: fileDesc.selectionEnd,
                content: content,
                discussionListJSON: fileDesc.discussionListJSON
            };
            this.currentMode = undefined;
            lastMode = undefined;
            contentElt.textContent = content;
        };
    }
    var undoMgr = new UndoMgr();
    editor.undoMgr = undoMgr;

    function onComment() {
        if(watcher.isWatching === true) {
            undoMgr.currentMode = 'comment';
            undoMgr.saveState();
        }
    }
    eventMgr.addListener('onDiscussionCreated', onComment);
    eventMgr.addListener('onDiscussionRemoved', onComment);
    eventMgr.addListener('onCommentsChanged', onComment);

    function checkContentChange() {
        var currentTextContent = inputElt.textContent;
        if(fileChanged === false) {
            if(currentTextContent == textContent) {
                return;
            }
            if(!/\n$/.test(currentTextContent)) {
                currentTextContent += '\n';
            }
            undoMgr.currentMode = undoMgr.currentMode || 'typing';
            var changes = diffMatchPatch.diff_main(textContent, currentTextContent);
            textContent = currentTextContent;
            // Move comments according to changes
            var updateDiscussionList = false;
            var startOffset = 0;
            var discussionList = _.values(fileDesc.discussionList);
            fileDesc.newDiscussion && discussionList.push(fileDesc.newDiscussion);
            changes.forEach(function(change) {
                var changeType = change[0];
                var changeText = change[1];
                if(changeType === 0) {
                    startOffset += changeText.length;
                    return;
                }
                var endOffset = startOffset;
                var diffOffset = changeText.length;
                if(changeType === -1) {
                    endOffset += diffOffset;
                    diffOffset = -diffOffset;
                }
                discussionList.forEach(function(discussion) {
                    // selectionEnd
                    if(discussion.selectionEnd >= endOffset) {
                        discussion.selectionEnd += diffOffset;
                        updateDiscussionList = true;
                    }
                    else if(discussion.selectionEnd > startOffset) {
                        discussion.selectionEnd = startOffset;
                        updateDiscussionList = true;
                    }
                    // selectionStart
                    if(discussion.selectionStart >= endOffset) {
                        discussion.selectionStart += diffOffset;
                        updateDiscussionList = true;
                    }
                    else if(discussion.selectionStart > startOffset) {
                        discussion.selectionStart = startOffset;
                        updateDiscussionList = true;
                    }
                });
                startOffset = endOffset;
            });
            if(updateDiscussionList === true) {
                fileDesc.discussionList = fileDesc.discussionList; // Write discussionList in localStorage
            }
            fileDesc.content = textContent;
            selectionMgr.saveSelectionState();
            eventMgr.onContentChanged(fileDesc, textContent);
            updateDiscussionList && eventMgr.onCommentsChanged(fileDesc);
            undoMgr.saveState();
        }
        else {
            if(!/\n$/.test(currentTextContent)) {
                currentTextContent += '\n';
                fileDesc.content = currentTextContent;
            }
            textContent = currentTextContent;
            selectionMgr.setSelectionStartEnd(fileDesc.editorStart, fileDesc.editorEnd);
            eventMgr.onFileOpen(fileDesc, textContent);
            previewElt.scrollTop = fileDesc.previewScrollTop;
            scrollTop = fileDesc.editorScrollTop;
            inputElt.scrollTop = scrollTop;
            fileChanged = false;
        }
    }

    editor.init = function(elt1, elt2) {
        inputElt = elt1;
        $inputElt = $(inputElt);
        editor.inputElt = inputElt;
        editor.$inputElt = $inputElt;

        previewElt = elt2;

        contentElt = crel('div', {
            class: 'editor-content',
            contenteditable: true
        });
        inputElt.appendChild(contentElt);
        editor.contentElt = contentElt;
        $contentElt = $(contentElt);
        editor.$contentElt = $contentElt;

        marginElt = crel('div', {
            class: 'editor-margin'
        });
        inputElt.appendChild(marginElt);
        $marginElt = $(marginElt);
        editor.$marginElt = $marginElt;

        watcher.startWatching();

        $(inputElt).scroll(function() {
            scrollTop = inputElt.scrollTop;
            if(fileChanged === false) {
                fileDesc.editorScrollTop = scrollTop;
            }
        });
        $(previewElt).scroll(function() {
            if(fileChanged === false) {
                fileDesc.previewScrollTop = previewElt.scrollTop;
            }
        });

        inputElt.focus = function() {
            $contentElt.focus();
            selectionMgr.setSelectionStartEnd();
            inputElt.scrollTop = scrollTop;
        };
        $contentElt.focus(function() {
            inputElt.focused = true;
        });
        $contentElt.blur(function() {
            inputElt.focused = false;
        });

        Object.defineProperty(inputElt, 'value', {
            get: function () {
                return textContent;
            },
            set: setValue
        });

        Object.defineProperty(inputElt, 'selectionStart', {
            get: function () {
                return selectionMgr.selectionStart;
            },
            set: function (value) {
                selectionMgr.setSelectionStartEnd(value);
            },

            enumerable: true,
            configurable: true
        });

        Object.defineProperty(inputElt, 'selectionEnd', {
            get: function () {
                return selectionMgr.selectionEnd;
            },
            set: function (value) {
                selectionMgr.setSelectionStartEnd(undefined, value);
            },

            enumerable: true,
            configurable: true
        });

        var clearNewline = false;
        $contentElt.on('keydown', function (evt) {
            if(
                evt.which === 17 || // Ctrl
                evt.which === 91 || // Cmd
                evt.which === 18 || // Alt
                evt.which === 16 // Shift
            ) {
                return;
            }
            selectionMgr.saveSelectionState();

            var cmdOrCtrl = evt.metaKey || evt.ctrlKey;
            if(!cmdOrCtrl) {
                adjustCursorPosition();
            }

            switch (evt.which) {
            case 9: // Tab
                if (!cmdOrCtrl) {
                    action('indent', {
                        inverse: evt.shiftKey
                    });
                    evt.preventDefault();
                }
                break;
            case 13:
                action('newline');
                evt.preventDefault();
                break;
            }
            if(evt.which !== 13) {
                clearNewline = false;
            }
        })
        .on('mouseup', function() {
            setTimeout(function() {
                selectionMgr.saveSelectionState();
            }, 0);
        })
        .on('paste', function () {
            undoMgr.currentMode = 'paste';
            adjustCursorPosition();
        })
        .on('cut', function () {
            undoMgr.currentMode = 'cut';
            adjustCursorPosition();
        });

        var action = function (action, options) {
            options = options || {};

            var text = inputElt.value,
                ss = options.start || selectionMgr.selectionStart,
                se = options.end || selectionMgr.selectionEnd,
                state = {
                    ss: ss,
                    se: se,
                    before: text.slice(0, ss),
                    after: text.slice(se),
                    selection: text.slice(ss, se)
                };

            actions[action](state, options);
            inputElt.value = state.before + state.selection + state.after;
            selectionMgr.setSelectionStartEnd(state.ss, state.se);
            $inputElt.trigger('input');
        };

        var actions = {
            indent: function (state, options) {
                var lf = state.before.lastIndexOf('\n') + 1;

                if (options.inverse) {
                    if (/\s/.test(state.before.charAt(lf))) {
                        state.before = strSplice(state.before, lf, 1);

                        state.ss--;
                        state.se--;
                    }

                    state.selection = state.selection.replace(/^[ \t]/gm, '');
                } else if (state.selection) {
                    state.before = strSplice(state.before, lf, 0, '\t');
                    state.selection = state.selection.replace(/\r?\n(?=[\s\S])/g, '\n\t');

                    state.ss++;
                    state.se++;
                } else {
                    state.before += '\t';

                    state.ss++;
                    state.se++;

                    return;
                }

                state.se = state.ss + state.selection.length;
            },

            newline: function (state) {
                var lf = state.before.lastIndexOf('\n') + 1;
                if(clearNewline) {
                    state.before = state.before.substring(0, lf);
                    state.selection = '';
                    state.ss = lf;
                    state.se = lf;
                    clearNewline = false;
                    return;
                }
                clearNewline = false;
                var previousLine = state.before.slice(lf);
                var indentMatch = previousLine.match(/^ {0,3}>[ ]*|^[ \t]*(?:[*+\-]|(\d+)\.)[ \t]|^\s+/);
                var indent = (indentMatch || [''])[0];
                if(indentMatch && indentMatch[1]) {
                    var number = parseInt(indentMatch[1], 10);
                    indent = indent.replace(/\d+/, number + 1);
                }
                if(indent.length) {
                    clearNewline = true;
                }

                undoMgr.currentMode = 'newlines';

                state.before += '\n' + indent;
                state.selection = '';
                state.ss += indent.length + 1;
                state.se = state.ss;
            },
        };
    };

    var sectionList = [];
    var sectionsToRemove = [];
    var modifiedSections = [];
    var insertBeforeSection;
    function updateSectionList(newSectionList) {

        modifiedSections = [];
        sectionsToRemove = [];
        insertBeforeSection = undefined;

        // Render everything if file changed
        if(fileChanged === true) {
            sectionsToRemove = sectionList;
            sectionList = newSectionList;
            modifiedSections = newSectionList;
            return;
        }

        // Find modified section starting from top
        var leftIndex = sectionList.length;
        _.some(sectionList, function(section, index) {
            var newSection = newSectionList[index];
            if(index >= newSectionList.length ||
                // Check modified
                section.textWithFrontMatter != newSection.textWithFrontMatter ||
                // Check that section has not been detached or moved
                section.elt.parentNode !== contentElt ||
                // Check also the content since nodes can be injected in sections via copy/paste
                section.elt.textContent != newSection.textWithFrontMatter) {
                leftIndex = index;
                return true;
            }
        });

        // Find modified section starting from bottom
        var rightIndex = -sectionList.length;
        _.some(sectionList.slice().reverse(), function(section, index) {
            var newSection = newSectionList[newSectionList.length - index - 1];
            if(index >= newSectionList.length ||
                // Check modified
                section.textWithFrontMatter != newSection.textWithFrontMatter ||
                // Check that section has not been detached or moved
                section.elt.parentNode !== contentElt ||
                // Check also the content since nodes can be injected in sections via copy/paste
                section.elt.textContent != newSection.textWithFrontMatter) {
                rightIndex = -index;
                return true;
            }
        });

        if(leftIndex - rightIndex > sectionList.length) {
            // Prevent overlap
            rightIndex = leftIndex - sectionList.length;
        }

        // Create an array composed of left unmodified, modified, right
        // unmodified sections
        var leftSections = sectionList.slice(0, leftIndex);
        modifiedSections = newSectionList.slice(leftIndex, newSectionList.length + rightIndex);
        var rightSections = sectionList.slice(sectionList.length + rightIndex, sectionList.length);
        insertBeforeSection = _.first(rightSections);
        sectionsToRemove = sectionList.slice(leftIndex, sectionList.length + rightIndex);
        sectionList = leftSections.concat(modifiedSections).concat(rightSections);
    }

    function highlightSections() {
        var newSectionEltList = document.createDocumentFragment();
        modifiedSections.forEach(function(section) {
            highlight(section);
            newSectionEltList.appendChild(section.elt);
        });
        watcher.noWatch(function() {
            if(fileChanged === true) {
                contentElt.innerHTML = '';
                contentElt.appendChild(newSectionEltList);
                selectionMgr.setSelectionStartEnd();
            }
            else {
                // Remove outdated sections
                sectionsToRemove.forEach(function(section) {
                    // section can be already removed
                    section.elt.parentNode === contentElt && contentElt.removeChild(section.elt);
                });

                if(insertBeforeSection !== undefined) {
                    contentElt.insertBefore(newSectionEltList, insertBeforeSection.elt);
                }
                else {
                    contentElt.appendChild(newSectionEltList);
                }

                // Remove unauthorized nodes (text nodes outside of sections or duplicated sections via copy/paste)
                var childNode = contentElt.firstChild;
                while(childNode) {
                    var nextNode = childNode.nextSibling;
                    if(!childNode.generated) {
                        contentElt.removeChild(childNode);
                    }
                    childNode = nextNode;
                }
                selectionMgr.setSelectionStartEnd();
            }
        });
    }

    var entityMap = {
        "&": "&amp;",
        "<": "&lt;",
        "\u00a0": ' ',
    };

    function escape(str) {
        return str.replace(/[&<\u00a0]/g, function(s) {
            return entityMap[s];
        });
    }

    function highlight(section) {
        var text = escape(section.text);
        text = Prism.highlight(text, Prism.languages.md);
        var frontMatter = section.textWithFrontMatter.substring(0, section.textWithFrontMatter.length - section.text.length);
        if(frontMatter.length) {
            // Front matter highlighting
            frontMatter = escape(frontMatter);
            frontMatter = frontMatter.replace(/\n/g, '<span class="token lf">\n</span>');
            text = '<span class="token md">' + frontMatter + '</span>' + text;
        }
        var sectionElt = crel('span', {
            id: 'wmd-input-section-' + section.id,
            class: 'wmd-input-section'
        });
        sectionElt.generated = true;
        sectionElt.innerHTML = text;
        section.elt = sectionElt;
    }

    eventMgr.onEditorCreated(editor);
    return editor;
});
