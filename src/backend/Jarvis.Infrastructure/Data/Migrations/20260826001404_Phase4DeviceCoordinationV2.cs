using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Jarvis.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class Phase4DeviceCoordinationV2 : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "ClientEventId",
                table: "TaskEvents",
                type: "TEXT",
                maxLength: 200,
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "DeviceId",
                table: "TaskEvents",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "ExecutionId",
                table: "TaskEvents",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "CredentialHash",
                table: "Devices",
                type: "TEXT",
                maxLength: 256,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "TaskExecutions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    TaskId = table.Column<Guid>(type: "TEXT", nullable: false),
                    DeviceId = table.Column<Guid>(type: "TEXT", nullable: true),
                    WorkerKind = table.Column<int>(type: "INTEGER", nullable: false),
                    ExternalExecutionId = table.Column<string>(type: "TEXT", maxLength: 500, nullable: true),
                    CodexThreadId = table.Column<string>(type: "TEXT", maxLength: 500, nullable: true),
                    CodexTurnId = table.Column<string>(type: "TEXT", maxLength: 500, nullable: true),
                    Status = table.Column<int>(type: "INTEGER", nullable: false),
                    StartedAtMs = table.Column<long>(type: "INTEGER", nullable: false),
                    EndedAtMs = table.Column<long>(type: "INTEGER", nullable: true),
                    MetadataJson = table.Column<string>(type: "TEXT", maxLength: 100000, nullable: false),
                    ResultPayloadJson = table.Column<string>(type: "TEXT", maxLength: 1000000, nullable: true),
                    ArtifactManifestJson = table.Column<string>(type: "TEXT", maxLength: 1000000, nullable: false),
                    Version = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TaskExecutions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_TaskExecutions_Devices_DeviceId",
                        column: x => x.DeviceId,
                        principalTable: "Devices",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TaskExecutions_Tasks_TaskId",
                        column: x => x.TaskId,
                        principalTable: "Tasks",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "Approvals",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    TaskId = table.Column<Guid>(type: "TEXT", nullable: false),
                    ExecutionId = table.Column<Guid>(type: "TEXT", nullable: true),
                    DeviceId = table.Column<Guid>(type: "TEXT", nullable: false),
                    RequestId = table.Column<string>(type: "TEXT", maxLength: 200, nullable: true),
                    Kind = table.Column<int>(type: "INTEGER", nullable: false),
                    Reason = table.Column<string>(type: "TEXT", maxLength: 4000, nullable: false),
                    RequestedActionJson = table.Column<string>(type: "TEXT", maxLength: 1000000, nullable: false),
                    Status = table.Column<int>(type: "INTEGER", nullable: false),
                    Scope = table.Column<int>(type: "INTEGER", nullable: true),
                    DecidedByDeviceId = table.Column<Guid>(type: "TEXT", nullable: true),
                    Decision = table.Column<int>(type: "INTEGER", nullable: true),
                    CreatedAtMs = table.Column<long>(type: "INTEGER", nullable: false),
                    DecidedAtMs = table.Column<long>(type: "INTEGER", nullable: true),
                    ExpiresAtMs = table.Column<long>(type: "INTEGER", nullable: true),
                    Version = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Approvals", x => x.Id);
                    table.ForeignKey(
                        name: "FK_Approvals_Devices_DeviceId",
                        column: x => x.DeviceId,
                        principalTable: "Devices",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_Approvals_TaskExecutions_ExecutionId",
                        column: x => x.ExecutionId,
                        principalTable: "TaskExecutions",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_Approvals_Tasks_TaskId",
                        column: x => x.TaskId,
                        principalTable: "Tasks",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_TaskEvents_TaskId_DeviceId_ClientEventId",
                table: "TaskEvents",
                columns: new[] { "TaskId", "DeviceId", "ClientEventId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Notifications_ApprovalId",
                table: "Notifications",
                column: "ApprovalId");

            migrationBuilder.CreateIndex(
                name: "IX_Approvals_DeviceId_RequestId",
                table: "Approvals",
                columns: new[] { "DeviceId", "RequestId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Approvals_ExecutionId",
                table: "Approvals",
                column: "ExecutionId");

            migrationBuilder.CreateIndex(
                name: "IX_Approvals_TaskId_Status_CreatedAtMs",
                table: "Approvals",
                columns: new[] { "TaskId", "Status", "CreatedAtMs" });

            migrationBuilder.CreateIndex(
                name: "IX_TaskExecutions_DeviceId",
                table: "TaskExecutions",
                column: "DeviceId");

            migrationBuilder.CreateIndex(
                name: "IX_TaskExecutions_TaskId",
                table: "TaskExecutions",
                column: "TaskId");

            migrationBuilder.CreateIndex(
                name: "IX_TaskExecutions_TaskId_Status",
                table: "TaskExecutions",
                columns: new[] { "TaskId", "Status" });

            migrationBuilder.AddForeignKey(
                name: "FK_Notifications_Approvals_ApprovalId",
                table: "Notifications",
                column: "ApprovalId",
                principalTable: "Approvals",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_Notifications_Approvals_ApprovalId",
                table: "Notifications");

            migrationBuilder.DropTable(
                name: "Approvals");

            migrationBuilder.DropTable(
                name: "TaskExecutions");

            migrationBuilder.DropIndex(
                name: "IX_TaskEvents_TaskId_DeviceId_ClientEventId",
                table: "TaskEvents");

            migrationBuilder.DropIndex(
                name: "IX_Notifications_ApprovalId",
                table: "Notifications");

            migrationBuilder.DropColumn(
                name: "ClientEventId",
                table: "TaskEvents");

            migrationBuilder.DropColumn(
                name: "DeviceId",
                table: "TaskEvents");

            migrationBuilder.DropColumn(
                name: "ExecutionId",
                table: "TaskEvents");

            migrationBuilder.DropColumn(
                name: "CredentialHash",
                table: "Devices");
        }
    }
}
