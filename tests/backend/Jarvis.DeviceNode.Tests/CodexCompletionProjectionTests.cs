using System.Security.Cryptography;
using System.Text.Json;
using Jarvis.Application.Devices;
using Jarvis.Contracts;
using Jarvis.DeviceNode;
using Jarvis.DeviceNode.Codex;
using Xunit;

namespace Jarvis.DeviceNode.Tests;

public sealed class CodexCompletionProjectionTests
{
    private const string ExpectedThreadId = "thread-expected";
    private const string ExpectedTurnId = "turn-expected";

    [Fact]
    public void UsesTheFinalNestedAgentMessageAndHashesCompletedLocalChanges()
    {
        var root = Directory.CreateTempSubdirectory("jarvis-codex-completion-");
        try
        {
            var firstPath = Path.Combine(root.FullName, "first.txt");
            var movedPath = Path.Combine(root.FullName, "moved.txt");
            File.WriteAllText(movedPath, "moved result");
            var policy = ReadPolicy(root.FullName);
            using var document = JsonDocument.Parse(JsonSerializer.Serialize(new
            {
                turn = new
                {
                    id = ExpectedTurnId,
                    status = "completed",
                    items = new object[]
                    {
                        new { id = "message-1", type = "agentMessage", phase = "commentary", text = "draft" },
                        new { id = "message-2", type = "agentMessage", phase = "final_answer", text = "the final answer" },
                        new
                        {
                            id = "change-1",
                            type = "fileChange",
                            status = "completed",
                            changes = new object[]
                            {
                                new { kind = new { type = "add" }, path = firstPath, diff = "+first" },
                                new { kind = new { type = "update", move_path = movedPath }, path = Path.Combine(root.FullName, "old.txt"), diff = "move" },
                                new { kind = new { type = "delete" }, path = Path.Combine(root.FullName, "deleted.txt"), diff = "-deleted" }
                            }
                        }
                    }
                },
                threadId = ExpectedThreadId
            }));

            File.WriteAllText(firstPath, "first result");
            var expected = ExpectedTurn();
            var summary = CodexCompletionProjection.ExtractFinalAnswer(document.RootElement, expected);
            var artifacts = CodexCompletionProjection.ExtractArtifacts(document.RootElement, policy, expected);

            Assert.Equal("the final answer", summary);
            Assert.Equal(2, artifacts.Length);
            Assert.Equal(Path.GetFullPath(firstPath), artifacts[0].Path);
            Assert.Equal(Path.GetFullPath(movedPath), artifacts[1].Path);
            Assert.Equal("first result".Length, artifacts[0].Size);
            Assert.Equal(
                Convert.ToHexString(SHA256.HashData("first result"u8.ToArray())),
                artifacts[0].Sha256);
        }
        finally
        {
            root.Delete(recursive: true);
        }
    }

    [Fact]
    public void AcceptsNullMovePathForAnUpdateAndUsesTheChangePath()
    {
        var root = Directory.CreateTempSubdirectory("jarvis-codex-completion-null-move-");
        try
        {
            var path = Path.Combine(root.FullName, "updated.txt");
            File.WriteAllText(path, "updated result");
            using var document = JsonDocument.Parse(JsonSerializer.Serialize(new
            {
                threadId = ExpectedThreadId,
                turn = new
                {
                    id = ExpectedTurnId,
                    status = "completed",
                    items = new object[]
                    {
                        new
                        {
                            type = "fileChange",
                            status = "completed",
                            changes = new[]
                            {
                                new { kind = new { type = "update", move_path = (string?)null }, path, diff = "update" }
                            }
                        }
                    }
                }
            }));

            var artifacts = CodexCompletionProjection.ExtractArtifacts(
                document.RootElement,
                ReadPolicy(root.FullName),
                ExpectedTurn());

            var artifact = Assert.Single(artifacts);
            Assert.Equal(path, artifact.Path);
            Assert.Equal("updated result".Length, artifact.Size);
        }
        finally
        {
            root.Delete(recursive: true);
        }
    }

    [Fact]
    public void ProjectsOnlyFilesPresentAfterDeletesAndMoves()
    {
        var root = Directory.CreateTempSubdirectory("jarvis-codex-completion-final-state-");
        try
        {
            var sourcePath = Path.Combine(root.FullName, "source.txt");
            var destinationPath = Path.Combine(root.FullName, "destination.txt");
            File.WriteAllText(destinationPath, "moved result");
            var policy = ReadPolicy(root.FullName);

            using var deleted = JsonDocument.Parse(JsonSerializer.Serialize(new
            {
                threadId = ExpectedThreadId,
                turn = new
                {
                    id = ExpectedTurnId,
                    status = "completed",
                    items = new object[]
                    {
                        new
                        {
                            type = "fileChange",
                            status = "completed",
                            changes = new object[]
                            {
                                new { kind = new { type = "add" }, path = sourcePath },
                                new { kind = new { type = "delete" }, path = sourcePath }
                            }
                        }
                    }
                }
            }));
            Assert.Empty(CodexCompletionProjection.ExtractArtifacts(deleted.RootElement, policy, ExpectedTurn()));

            using var moved = JsonDocument.Parse(JsonSerializer.Serialize(new
            {
                threadId = ExpectedThreadId,
                turn = new
                {
                    id = ExpectedTurnId,
                    status = "completed",
                    items = new object[]
                    {
                        new
                        {
                            type = "fileChange",
                            status = "completed",
                            changes = new object[]
                            {
                                new { kind = new { type = "add" }, path = sourcePath },
                                new { kind = new { type = "update", move_path = destinationPath }, path = sourcePath }
                            }
                        }
                    }
                }
            }));
            var artifact = Assert.Single(CodexCompletionProjection.ExtractArtifacts(moved.RootElement, policy, ExpectedTurn()));
            Assert.Equal(destinationPath, artifact.Path);
            Assert.Equal("moved result".Length, artifact.Size);
        }
        finally
        {
            root.Delete(recursive: true);
        }
    }

    [Fact]
    public void IgnoresDeclinedChangesAndDeletesButRejectsOutOfRootChanges()
    {
        var root = Directory.CreateTempSubdirectory("jarvis-codex-completion-boundary-");
        var outside = Path.Combine(Path.GetTempPath(), $"jarvis-outside-{Guid.NewGuid():N}.txt");
        File.WriteAllText(outside, "outside");
        try
        {
            var policy = ReadPolicy(root.FullName);
            using var declined = JsonDocument.Parse(JsonSerializer.Serialize(new
            {
                turn = new
                {
                    id = ExpectedTurnId,
                    status = "completed",
                    items = new object[]
                    {
                        new
                        {
                            id = "declined",
                            type = "fileChange",
                            status = "declined",
                            changes = new[] { new { kind = new { type = "add" }, path = outside, diff = "+secret" } }
                        },
                        new
                        {
                            id = "deleted",
                            type = "fileChange",
                            status = "completed",
                            changes = new[] { new { kind = new { type = "delete" }, path = Path.Combine(root.FullName, "deleted.txt"), diff = "-secret" } }
                        }
                    }
                },
                threadId = ExpectedThreadId
            }));

            var expected = ExpectedTurn();
            Assert.Empty(CodexCompletionProjection.ExtractArtifacts(declined.RootElement, policy, expected));

            using var added = JsonDocument.Parse(JsonSerializer.Serialize(new
            {
                turn = new
                {
                    id = ExpectedTurnId,
                    status = "completed",
                    items = new[]
                    {
                        new
                        {
                            id = "out-of-root",
                            type = "fileChange",
                            status = "completed",
                            changes = new[] { new { kind = new { type = "add" }, path = outside, diff = "+secret" } }
                        }
                    }
                },
                threadId = ExpectedThreadId
            }));

            Assert.Throws<InvalidDataException>(() => CodexCompletionProjection.ExtractArtifacts(added.RootElement, policy, expected));
        }
        finally
        {
            File.Delete(outside);
            root.Delete(recursive: true);
        }
    }

    [Fact]
    public void RejectsInProgressNestedFileChangesAndSymlinkedFiles()
    {
        var root = Directory.CreateTempSubdirectory("jarvis-codex-completion-symlink-");
        try
        {
            var policy = ReadPolicy(root.FullName);
            using var inProgress = JsonDocument.Parse(JsonSerializer.Serialize(new
            {
                turn = new
                {
                    id = ExpectedTurnId,
                    status = "inProgress",
                    items = new[]
                    {
                        new
                        {
                            id = "in-progress",
                            type = "fileChange",
                            status = "inProgress",
                            changes = Array.Empty<object>()
                        }
                    }
                },
                threadId = ExpectedThreadId
            }));
            var expected = ExpectedTurn();
            Assert.Throws<InvalidDataException>(() => CodexCompletionProjection.ExtractArtifacts(inProgress.RootElement, policy, expected));

            if (OperatingSystem.IsWindows())
            {
                return;
            }

            var outside = Path.Combine(Path.GetTempPath(), $"jarvis-symlink-target-{Guid.NewGuid():N}.txt");
            var link = Path.Combine(root.FullName, "linked.txt");
            File.WriteAllText(outside, "target");
            File.CreateSymbolicLink(link, outside);
            try
            {
                using var symlink = JsonDocument.Parse(JsonSerializer.Serialize(new
                {
                    turn = new
                    {
                        id = ExpectedTurnId,
                        status = "completed",
                        items = new[]
                        {
                            new
                            {
                                id = "symlink",
                                type = "fileChange",
                                status = "completed",
                                changes = new[] { new { kind = new { type = "add" }, path = link, diff = "+target" } }
                            }
                        }
                    },
                    threadId = ExpectedThreadId
                }));
                Assert.Throws<InvalidDataException>(() => CodexCompletionProjection.ExtractArtifacts(symlink.RootElement, policy, expected));
            }
            finally
            {
                File.Delete(link);
                File.Delete(outside);
            }
        }
        finally
        {
            root.Delete(recursive: true);
        }
    }

    [Theory]
    [InlineData("completed")]
    [InlineData("interrupted")]
    [InlineData("failed")]
    [InlineData("inProgress")]
    public void ReadsTheNestedTurnStatus(string status)
    {
        using var document = JsonDocument.Parse($"{{\"threadId\":\"{ExpectedThreadId}\",\"turn\":{{\"id\":\"{ExpectedTurnId}\",\"status\":\"{status}\",\"items\":[{{\"type\":\"agentMessage\",\"text\":\"fixture\"}}]}}}}");

        Assert.Equal(status, CodexCompletionProjection.ExtractStatus(document.RootElement, ExpectedTurn()));
    }

    [Fact]
    public void RejectsNestedCompletionWithoutItemsEvenWhenLegacyOutputIsPresent()
    {
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(new
        {
            threadId = ExpectedThreadId,
            summary = "legacy success must not be trusted",
            artifacts = Array.Empty<object>(),
            turn = new { id = ExpectedTurnId, status = "completed", items = Array.Empty<object>() }
        }));

        var expected = ExpectedTurn();
        Assert.Throws<InvalidDataException>(() => CodexCompletionProjection.ExtractFinalAnswer(document.RootElement, expected));
        Assert.Throws<InvalidDataException>(() => CodexCompletionProjection.ExtractArtifacts(document.RootElement, ReadPolicy(Path.GetTempPath()), expected));
    }

    [Theory]
    [InlineData("notLoaded")]
    [InlineData("summary")]
    public void RejectsPartialNestedItemsView(string itemsView)
    {
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(new
        {
            threadId = ExpectedThreadId,
            turn = new
            {
                id = ExpectedTurnId,
                status = "completed",
                itemsView,
                items = new[] { new { type = "agentMessage", text = "answer" } }
            }
        }));

        Assert.Throws<InvalidDataException>(() => CodexCompletionProjection.ExtractFinalAnswer(document.RootElement, ExpectedTurn()));
    }

    [Fact]
    public void ProjectsSummaryNotificationFromAnExactThreadReadTurn()
    {
        var root = Directory.CreateTempSubdirectory("jarvis-codex-thread-read-");
        try
        {
            var path = Path.Combine(root.FullName, "thread-read.txt");
            File.WriteAllText(path, "thread history");
            var policy = ReadPolicy(root.FullName);
            var expected = ExpectedTurn();
            using var summary = JsonDocument.Parse(JsonSerializer.Serialize(new
            {
                threadId = ExpectedThreadId,
                turn = new
                {
                    id = ExpectedTurnId,
                    status = "completed",
                    itemsView = "summary",
                    items = new[] { new { id = "summary", type = "agentMessage", text = "summary only" } }
                }
            }));
            Assert.True(CodexCompletionProjection.RequiresFullThreadRead(summary.RootElement, expected));

            using var read = JsonDocument.Parse(JsonSerializer.Serialize(new
            {
                thread = new
                {
                    id = ExpectedThreadId,
                    turns = new[]
                    {
                        new
                        {
                            id = ExpectedTurnId,
                            status = "completed",
                            itemsView = "full",
                            items = new object[]
                            {
                                new { id = "message", type = "agentMessage", phase = "final_answer", text = "full answer" },
                                new { id = "change", type = "fileChange", status = "completed", changes = new[] { new { kind = new { type = "add" }, path, diff = "+thread history" } } }
                            }
                        }
                    }
                }
            }));

            var full = CodexCompletionProjection.CreateFullCompletionParameters(read.RootElement, expected);
            Assert.Equal("full answer", CodexCompletionProjection.ExtractFinalAnswer(full, expected));
            var artifacts = CodexCompletionProjection.ExtractArtifacts(full, policy, expected);
            Assert.Single(artifacts);
            Assert.Equal(path, artifacts[0].Path);
        }
        finally
        {
            root.Delete(recursive: true);
        }
    }

    [Fact]
    public void RejectsMismatchedTurnIdentityAndConflictingTopLevelStatus()
    {
        using var wrongThread = JsonDocument.Parse(JsonSerializer.Serialize(new
        {
            threadId = "other-thread",
            turn = new { id = ExpectedTurnId, status = "completed", items = new[] { new { type = "agentMessage", text = "answer" } } }
        }));
        Assert.Throws<InvalidDataException>(() => CodexCompletionProjection.ExtractStatus(wrongThread.RootElement, ExpectedTurn()));

        using var wrongTurn = JsonDocument.Parse(JsonSerializer.Serialize(new
        {
            threadId = ExpectedThreadId,
            turn = new { id = "other-turn", status = "completed", items = new[] { new { type = "agentMessage", text = "answer" } } }
        }));
        Assert.Throws<InvalidDataException>(() => CodexCompletionProjection.ExtractStatus(wrongTurn.RootElement, ExpectedTurn()));

        using var conflicting = JsonDocument.Parse(JsonSerializer.Serialize(new
        {
            threadId = ExpectedThreadId,
            status = "failed",
            turn = new { id = ExpectedTurnId, status = "completed", items = new[] { new { type = "agentMessage", text = "answer" } } }
        }));
        Assert.Throws<InvalidDataException>(() => CodexCompletionProjection.ExtractStatus(conflicting.RootElement, ExpectedTurn()));
    }

    [Fact]
    public void DeduplicatesRepeatedCompletedChangesAndPreservesLongFinalAnswer()
    {
        var root = Directory.CreateTempSubdirectory("jarvis-codex-completion-repeat-");
        try
        {
            var path = Path.Combine(root.FullName, "result.txt");
            File.WriteAllText(path, "latest");
            var longAnswer = new string('x', 3_000);
            var policy = ReadPolicy(root.FullName);
            using var document = JsonDocument.Parse(JsonSerializer.Serialize(new
            {
                threadId = ExpectedThreadId,
                turn = new
                {
                    id = ExpectedTurnId,
                    status = "completed",
                    items = new object[]
                    {
                        new { type = "agentMessage", text = longAnswer },
                        new { type = "fileChange", status = "completed", changes = new[] { new { kind = new { type = "add" }, path, diff = "+old" } } },
                        new { type = "fileChange", status = "completed", changes = new[] { new { kind = new { type = "update" }, path, diff = "+latest" } } }
                    }
                }
            }));

            var expected = ExpectedTurn();
            var artifacts = CodexCompletionProjection.ExtractArtifacts(document.RootElement, policy, expected);
            Assert.Single(artifacts);
            Assert.Equal("latest".Length, artifacts[0].Size);
            Assert.Equal(longAnswer, CodexCompletionProjection.ExtractFinalAnswer(document.RootElement, expected));
        }
        finally
        {
            root.Delete(recursive: true);
        }
    }

    private static CodexTurnHandle ExpectedTurn() => new(ExpectedThreadId, ExpectedTurnId, default);

    private static CapabilityPolicy ReadPolicy(string root) => CapabilityPolicy.Create(
        new CapabilityEnvelope(ReadFiles: true, AllowedRoots: [root]));
}
