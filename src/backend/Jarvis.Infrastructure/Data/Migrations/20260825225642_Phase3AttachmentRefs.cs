using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Jarvis.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class Phase3AttachmentRefs : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "Tasks",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    UserId = table.Column<Guid>(type: "TEXT", nullable: false),
                    ConversationId = table.Column<Guid>(type: "TEXT", nullable: false),
                    CreatedByMessageId = table.Column<Guid>(type: "TEXT", nullable: true),
                    Goal = table.Column<string>(type: "TEXT", maxLength: 100000, nullable: false),
                    ExpectedOutput = table.Column<string>(type: "TEXT", maxLength: 100000, nullable: true),
                    RequiredCapabilitiesJson = table.Column<string>(type: "TEXT", nullable: false),
                    AttachmentRefsJson = table.Column<string>(type: "TEXT", maxLength: 200000, nullable: false),
                    PreferredDeviceId = table.Column<Guid>(type: "TEXT", nullable: true),
                    AssignedDeviceId = table.Column<Guid>(type: "TEXT", nullable: true),
                    WorkerKind = table.Column<int>(type: "INTEGER", nullable: false),
                    Status = table.Column<int>(type: "INTEGER", nullable: false),
                    Priority = table.Column<int>(type: "INTEGER", nullable: false),
                    Attempt = table.Column<int>(type: "INTEGER", nullable: false),
                    MaxAttempts = table.Column<int>(type: "INTEGER", nullable: false),
                    LeaseOwner = table.Column<string>(type: "TEXT", maxLength: 200, nullable: true),
                    LeaseExpiresAtMs = table.Column<long>(type: "INTEGER", nullable: true),
                    HeartbeatAtMs = table.Column<long>(type: "INTEGER", nullable: true),
                    ProgressSummary = table.Column<string>(type: "TEXT", maxLength: 2000, nullable: true),
                    ResultSummary = table.Column<string>(type: "TEXT", maxLength: 100000, nullable: true),
                    ResultPayloadJson = table.Column<string>(type: "TEXT", maxLength: 1000000, nullable: true),
                    ErrorCode = table.Column<string>(type: "TEXT", maxLength: 200, nullable: true),
                    ErrorMessage = table.Column<string>(type: "TEXT", maxLength: 4000, nullable: true),
                    CreatedAtMs = table.Column<long>(type: "INTEGER", nullable: false),
                    StartedAtMs = table.Column<long>(type: "INTEGER", nullable: true),
                    CompletedAtMs = table.Column<long>(type: "INTEGER", nullable: true),
                    Version = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Tasks", x => x.Id);
                    table.ForeignKey(
                        name: "FK_Tasks_Conversations_ConversationId",
                        column: x => x.ConversationId,
                        principalTable: "Conversations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_Tasks_Devices_AssignedDeviceId",
                        column: x => x.AssignedDeviceId,
                        principalTable: "Devices",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_Tasks_Devices_PreferredDeviceId",
                        column: x => x.PreferredDeviceId,
                        principalTable: "Devices",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_Tasks_Users_UserId",
                        column: x => x.UserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "Notifications",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    UserId = table.Column<Guid>(type: "TEXT", nullable: false),
                    ConversationId = table.Column<Guid>(type: "TEXT", nullable: true),
                    TaskId = table.Column<Guid>(type: "TEXT", nullable: true),
                    ApprovalId = table.Column<Guid>(type: "TEXT", nullable: true),
                    Type = table.Column<string>(type: "TEXT", maxLength: 200, nullable: false),
                    Severity = table.Column<int>(type: "INTEGER", nullable: false),
                    Title = table.Column<string>(type: "TEXT", maxLength: 500, nullable: false),
                    Body = table.Column<string>(type: "TEXT", maxLength: 100000, nullable: false),
                    ActionsJson = table.Column<string>(type: "TEXT", nullable: false),
                    DedupKey = table.Column<string>(type: "TEXT", maxLength: 500, nullable: false),
                    Status = table.Column<int>(type: "INTEGER", nullable: false),
                    CreatedAtMs = table.Column<long>(type: "INTEGER", nullable: false),
                    DeliveredAtMs = table.Column<long>(type: "INTEGER", nullable: true),
                    ReadAtMs = table.Column<long>(type: "INTEGER", nullable: true),
                    ActionedAtMs = table.Column<long>(type: "INTEGER", nullable: true),
                    ExpiresAtMs = table.Column<long>(type: "INTEGER", nullable: true),
                    Version = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Notifications", x => x.Id);
                    table.ForeignKey(
                        name: "FK_Notifications_Conversations_ConversationId",
                        column: x => x.ConversationId,
                        principalTable: "Conversations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_Notifications_Tasks_TaskId",
                        column: x => x.TaskId,
                        principalTable: "Tasks",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_Notifications_Users_UserId",
                        column: x => x.UserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "TaskEvents",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    TaskId = table.Column<Guid>(type: "TEXT", nullable: false),
                    Sequence = table.Column<long>(type: "INTEGER", nullable: false),
                    EventType = table.Column<string>(type: "TEXT", maxLength: 200, nullable: false),
                    PayloadJson = table.Column<string>(type: "TEXT", nullable: false),
                    CreatedAtMs = table.Column<long>(type: "INTEGER", nullable: false),
                    Version = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TaskEvents", x => x.Id);
                    table.ForeignKey(
                        name: "FK_TaskEvents_Tasks_TaskId",
                        column: x => x.TaskId,
                        principalTable: "Tasks",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_Notifications_ConversationId",
                table: "Notifications",
                column: "ConversationId");

            migrationBuilder.CreateIndex(
                name: "IX_Notifications_TaskId",
                table: "Notifications",
                column: "TaskId");

            migrationBuilder.CreateIndex(
                name: "IX_Notifications_UserId_DedupKey",
                table: "Notifications",
                columns: new[] { "UserId", "DedupKey" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Notifications_UserId_Status_CreatedAtMs",
                table: "Notifications",
                columns: new[] { "UserId", "Status", "CreatedAtMs" });

            migrationBuilder.CreateIndex(
                name: "IX_TaskEvents_TaskId_Sequence",
                table: "TaskEvents",
                columns: new[] { "TaskId", "Sequence" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Tasks_AssignedDeviceId",
                table: "Tasks",
                column: "AssignedDeviceId");

            migrationBuilder.CreateIndex(
                name: "IX_Tasks_ConversationId_Status_CreatedAtMs",
                table: "Tasks",
                columns: new[] { "ConversationId", "Status", "CreatedAtMs" });

            migrationBuilder.CreateIndex(
                name: "IX_Tasks_PreferredDeviceId",
                table: "Tasks",
                column: "PreferredDeviceId");

            migrationBuilder.CreateIndex(
                name: "IX_Tasks_UserId_Status_CreatedAtMs",
                table: "Tasks",
                columns: new[] { "UserId", "Status", "CreatedAtMs" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "Notifications");

            migrationBuilder.DropTable(
                name: "TaskEvents");

            migrationBuilder.DropTable(
                name: "Tasks");
        }
    }
}
